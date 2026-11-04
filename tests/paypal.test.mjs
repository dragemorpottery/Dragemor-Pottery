import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { marketHandler } from '../lib/market.js';
import { Readable } from 'node:stream';
import { reserveStripeStock, releaseStripeStock, checkoutStockReady } from '../lib/checkout-stock.js';
import { PGlite } from '@electric-sql/pglite';
import { settings, validItems, cents, ensureTables, claimStock, releaseDenied,
  paypalCheckout, paypalWebhook, checkOrder, paidSession, fulfill } from '../lib/paypal.js';

const db = new PGlite();
const sql = async (parts, ...values) => (await db.query(parts.reduce((out, s, i) => out + (i ? '$' + i : '') + s, ''), values)).rows;
await db.exec(`CREATE TABLE products (product_id TEXT PRIMARY KEY, name TEXT, category TEXT DEFAULT 'Keramik', price INTEGER, status TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());`);
await ensureTables(sql);
const cfg = { enabled: true, sandbox: true, clientId: 'test-client', secret: 'test-secret', merchantId: 'MERCHANT12345', webhookId: 'WH123' };
const token = 'a'.repeat(64);
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(value) { this.body = value; return this; } });
const post = body => ({ method: 'POST', headers: { origin: 'https://dragemor-pottery.de', 'content-type': 'application/json' }, body });
let sequence = 10;
async function fixture({ voucher = true } = {}) {
  await db.exec('TRUNCATE products, vouchers, voucher_redemptions, paypal_orders, stripe_stock_claims');
  await db.exec(`INSERT INTO products (product_id,name,price,status) VALUES ('tasse-1','Tasse',2500,'available'),('teller-1','Teller',3000,'available');
    INSERT INTO vouchers (code,initial_value,balance,status) VALUES ('DRG-TEST-15',1500,1500,'active')`);
  const items = await sql`SELECT product_id AS id, name, price, updated_at::text AS version FROM products ORDER BY product_id`;
  const id = 'PAYPALORDER' + String(++sequence);
  const snapshot = { items, subtotal: 5500, discount: voucher ? 1500 : 0, total: voucher ? 4699 : 6199,
    voucher: voucher ? { code: 'DRG-TEST-15', amount: 1500 } : null };
  await sql`INSERT INTO paypal_orders (id,checkout_id,token_hash,sandbox,snapshot)
    VALUES (${id}, ${crypto.randomUUID()}, ${crypto.createHash('sha256').update(token).digest('hex')}, TRUE, ${JSON.stringify(snapshot)}::jsonb)`;
  return { ...(await sql`SELECT * FROM paypal_orders WHERE id = ${id}`)[0], snapshot };
}
function orderFor(row, status = 'APPROVED', captureStatus) {
  return { id: row.id, intent: 'CAPTURE', status, payer: { email_address: 'test@example.test' }, purchase_units: [{
    custom_id: row.checkout_id, payee: { merchant_id: cfg.merchantId }, amount: { currency_code: 'EUR', value: (row.snapshot.total/100).toFixed(2) },
    shipping: { name: { full_name: 'Test Kundin' }, address: { address_line_1: 'Testweg 1', postal_code: '24803', admin_area_2: 'Tielen', country_code: 'DE' } },
    ...(captureStatus ? { payments: { captures: [{ id: 'CAPTURE123456', final_capture: true, status: captureStatus,
      create_time: '2026-11-04T12:00:00Z', amount: { currency_code: 'EUR', value: (row.snapshot.total/100).toFixed(2) } }] } } : {})
  }] };
}
async function endpoint(row, action, deps = {}) {
  const res = response();
  await paypalCheckout(post({ action, orderId: row.id, token }), res, { cfg, sql, ...deps });
  return res;
}

test('configuration stays disabled until complete; preview never uses live keys', () => {
  const env = { PAYPAL_ENABLED: 'true', DATABASE_URL: 'db', RESEND_API_KEY: 'mail',
    PAYPAL_CLIENT_ID: 'live', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_MERCHANT_ID: 'merchant', PAYPAL_WEBHOOK_ID: 'webhook' };
  assert.equal(settings(env).enabled, true);
  assert.equal(settings({ ...env, VERCEL_ENV: 'preview' }).enabled, false);
  assert.equal(settings({ ...env, VERCEL_ENV: 'preview' }).clientId, undefined);
  assert.match(settings({ ...env, VERCEL_ENV: 'preview' }).base, /sandbox/);
  assert.equal(settings({ ...env, PAYPAL_ENABLED: 'false' }).enabled, false);
});
test('validates cents, duplicate IDs and input bounds', () => {
  assert.equal(cents('46.99'), 4699);
  for (const value of ['1.234', 'NaN', 46.99, '-1.00', '2e3', '1']) assert.throws(() => cents(value));
  assert.equal(validItems([{ id: 'tasse-1' }]), true);
  for (const value of [[], [{ id: '../x' }], [{ id: 'a' }, { id: 'a' }], Array.from({length: 21}, (_, i) => ({id: 'p'+i}))]) assert.equal(validItems(value), false);
});
test('configuration and CSRF checks do not touch the database or leak secrets', async () => {
  const res = response(); await paypalCheckout({method: 'GET'}, res, {cfg});
  assert.deepEqual(res.body, { enabled: true, clientId: 'test-client' });
  const forbidden = response(); await paypalCheckout({...post({action: 'create'}), headers: {origin: 'https://evil.test'}}, forbidden, {cfg});
  assert.equal(forbidden.code,403);
  const plain = response(); await paypalCheckout({...post({}), headers:{origin:'https://dragemor-pottery.de','content-type':'text/plain'}}, plain, {cfg});
  assert.equal(plain.code,415);
});
test('create uses database prices, names, voucher and EUR shipping instead of client totals', async () => {
  await fixture(); let payload;
  const res = response();
  await paypalCheckout(post({action: 'create', items:[{id:'tasse-1',price:1},{id:'teller-1'}], voucherCode:'drg test 15', total:1}),res,{cfg,sql,
    api: async (_cfg, _path, options) => {payload=options.body;return {id:'NEWPAYPAL12345'};}});
  assert.equal(res.code,200); assert.equal(res.body.token.length,64);
  assert.deepEqual(payload.purchase_units[0].amount.breakdown.shipping,{currency_code:'EUR',value:'6.99'});
  assert.equal(payload.purchase_units[0].amount.value,'46.99');
  const stored=(await sql`SELECT * FROM paypal_orders WHERE id = 'NEWPAYPAL12345'`)[0];
  assert.equal(stored.snapshot.items[0].price,2500);
  assert.notEqual(stored.token_hash,res.body.token);
  assert.equal((await sql`SELECT status FROM products LIMIT 1`)[0].status,'available');
});
test('capture atomically claims all stock and voucher; repeats cannot debit twice', async () => {
  const row = await fixture(); await claimStock(sql,row);
  assert.deepEqual((await sql`SELECT status FROM products`).map(p=>p.status),['sold','sold']);
  assert.equal((await sql`SELECT balance FROM vouchers`)[0].balance,0);
  assert.equal((await sql`SELECT COUNT(*)::int AS n FROM voucher_redemptions`)[0].n,1);
  await assert.rejects(claimStock(sql,row));
  assert.equal((await sql`SELECT balance FROM vouchers`)[0].balance,0);
});
test('a market sale or price edit prevents every stock/voucher write and PayPal capture', async () => {
  for (const update of ["status = 'sold'", 'price = 1', "updated_at = NOW() + INTERVAL '1 second'"]) {
    const row = await fixture(); await db.exec(`UPDATE products SET ${update} WHERE product_id = 'tasse-1'`);
    let captures=0;
    const res=await endpoint(row,'capture',{api:async (_c,path)=>{if(path.endsWith('/capture')) captures++;return orderFor(row);}});
    assert.equal(res.code,409); assert.equal(captures,0);
    assert.equal((await sql`SELECT status FROM products WHERE product_id = 'teller-1'`)[0].status,'available');
    assert.equal((await sql`SELECT balance FROM vouchers`)[0].balance,1500);
  }
});
test('Stripe voucher reservations block PayPal capture without claiming any stock', async () => {
  const row = await fixture();
  await sql`UPDATE vouchers SET reservation_token='stripe', reserved_until=NOW()+INTERVAL '1 hour'`;
  await assert.rejects(claimStock(sql,row));
  assert.equal((await sql`SELECT COUNT(*)::int AS n FROM products WHERE status='sold'`)[0].n,0);
});
test('no-voucher checkout leaves unrelated vouchers untouched', async () => {
  const row=await fixture({voucher:false});await claimStock(sql,row);
  assert.equal((await sql`SELECT balance FROM vouchers`)[0].balance,1500);
});
test('successful capture checks provider order and capture, keeps same idempotency key, replays safely', async () => {
  const row=await fixture(); let captured=false; const keys=[];
  const api=async (_c,path,options)=>{
    if(path.endsWith('/capture')){captured=true;keys.push(options.requestId);return orderFor(row,'COMPLETED','COMPLETED');}
    return captured?orderFor(row,'COMPLETED','COMPLETED'):orderFor(row);
  };
  let res=await endpoint(row,'capture',{api});assert.equal(res.code,200);assert.equal(res.body.status,'paid');
  res=await endpoint(row,'capture',{api});assert.equal(res.body.status,'paid');assert.equal(keys.length,1);
  assert.equal(keys[0],row.checkout_id+'-capture');
  assert.equal((await sql`SELECT COUNT(*)::int AS n FROM voucher_redemptions`)[0].n,1);
  const stored=(await sql`SELECT * FROM paypal_orders WHERE id=${row.id}`)[0];
  assert.equal(stored.paid_session.customer_details.address.city,'Tielen');
  assert.equal(stored.fulfilled_at,null); // webhook, not the customer request, sends mail
});
test('timeout retains the claim; retry reuses capture key and never silently releases stock', async () => {
  const row=await fixture();let keys=[];
  const api=async (_c,path,options)=>{if(path.endsWith('/capture')){keys.push(options.requestId);throw new Error('network timeout');}return orderFor(row);};
  assert.equal((await endpoint(row,'capture',{api})).code,500);
  assert.equal((await endpoint(row,'capture',{api})).code,500);
  assert.equal(keys[0],keys[1]);
  assert.equal((await sql`SELECT status FROM paypal_orders WHERE id=${row.id}`)[0].status,'capturing');
  assert.equal((await sql`SELECT COUNT(*)::int AS n FROM products WHERE status='sold'`)[0].n,2);
});
test('PENDING is not paid and does not send an invoice or release the claim', async () => {
  const row=await fixture();await claimStock(sql,row);let mails=0;
  const res=await endpoint(row,'status',{api:async()=>orderFor(row,'COMPLETED','PENDING'),fulfillOrder:async()=>mails++});
  assert.equal(res.body.status,'pending');assert.equal(mails,0);
  assert.equal((await sql`SELECT status FROM products LIMIT 1`)[0].status,'sold');
});
test('definitively denied capture restores voucher once and only stock still owned by this order', async () => {
  const row=await fixture();await claimStock(sql,row);
  await sql`UPDATE products SET updated_at = NOW()+INTERVAL '1 second' WHERE product_id='tasse-1'`;
  const res=await endpoint(row,'status',{api:async()=>orderFor(row,'COMPLETED','DECLINED')});
  assert.equal(res.body.status,'denied');
  assert.equal((await sql`SELECT status FROM products WHERE product_id='teller-1'`)[0].status,'available');
  assert.equal((await sql`SELECT status FROM products WHERE product_id='tasse-1'`)[0].status,'sold');
  await releaseDenied(sql,row);
  assert.equal((await sql`SELECT balance FROM vouchers`)[0].balance,1500);
});
test('wrong token, wrong amount, currency, merchant, country or order never charges', async () => {
  const row=await fixture();let calls=0;
  const res=response();await paypalCheckout(post({action:'capture',orderId:row.id,token:'b'.repeat(64)}),res,{cfg,sql,api:async()=>calls++});
  assert.equal(res.code,403);assert.equal(calls,0);
  for (const mutate of [o=>o.id='OTHERORDER123',o=>o.purchase_units[0].amount.value='0.01',o=>o.purchase_units[0].amount.currency_code='USD',
    o=>o.purchase_units[0].payee.merchant_id='OTHER',o=>o.purchase_units[0].shipping.address.country_code='FR']) {
    const order=orderFor(row);mutate(order);assert.throws(()=>checkOrder(order,row,cfg));
  }
  const order=orderFor(row,'COMPLETED','COMPLETED');order.purchase_units[0].payments.captures[0].amount.value='0.01';
  assert.equal(paidSession(order,row,cfg),null);
});
test('cancel only closes an unclaimed order; late approval cannot capture after cancellation', async () => {
  const row=await fixture();const res=await endpoint(row,'cancel');assert.equal(res.body.status,'cancelled');
  let calls=0;const replay=await endpoint(row,'capture',{api:async()=>calls++});assert.equal(replay.body.status,'cancelled');assert.equal(calls,0);
  assert.equal((await sql`SELECT balance FROM vouchers`)[0].balance,1500);
  const other=await fixture();await claimStock(sql,other);
  const pending=await endpoint(other,'cancel',{api:async()=>orderFor(other,'COMPLETED','PENDING')});assert.equal(pending.body.status,'pending');
});
function webhook(event, valid=true) {
  const req=Readable.from([JSON.stringify(event)]);req.method='POST';req.headers=Object.fromEntries([
    'paypal-auth-algo','paypal-cert-url','paypal-transmission-id','paypal-transmission-sig','paypal-transmission-time'
  ].map(k=>[k,'test']));return req;
}
test('unsigned/forged webhook cannot write; verified repeated webhook reconciles provider data', async () => {
  const row=await fixture();await claimStock(sql,row);
  const event={event_type:'PAYMENT.CAPTURE.COMPLETED',resource:{supplementary_data:{related_ids:{order_id:row.id}}}};
  let queries=0;const bad=response();await paypalWebhook(webhook(event),bad,{cfg,sql:async()=>queries++,api:async()=>({verification_status:'FAILURE'})});
  assert.equal(bad.code,400);assert.equal(queries,0);
  let runs=0;
  const deps={cfg,sql,api:async(_c,path)=>path.includes('verify-webhook')?{verification_status:'SUCCESS'}:orderFor(row,'COMPLETED','COMPLETED'),fulfillOrder:async()=>runs++};
  for(let i=0;i<2;i++){const res=response();await paypalWebhook(webhook(event),res,deps);assert.equal(res.code,200);}
  assert.equal(runs,2);assert.equal((await sql`SELECT status FROM paypal_orders WHERE id=${row.id}`)[0].status,'paid');
  assert.equal((await sql`SELECT COUNT(*)::int AS n FROM voucher_redemptions`)[0].n,1);
});
test('fulfillment checkpoints retry failed mail without repeating invoice or successful messages', async () => {
  const row=await fixture();await claimStock(sql,row);
  await sql`UPDATE paypal_orders SET status='paid',paid_session=${JSON.stringify(paidSession(orderFor(row,'COMPLETED','COMPLETED'),row,cfg))}::jsonb WHERE id=${row.id}`;
  const sent=[];let attempts=0;let pdfs=0;
  const deps={makeInvoice:async()=>{sent.push('invoice');return 'DP-2026-0001';},makePdf:async()=>{pdfs++;return Buffer.from('pdf');},
    internalEmail:async session=>{assert.equal(session.email_keys.internal,'paypal-internal-'+row.id);sent.push('internal');},
    customerEmail:async()=>{if(attempts++===0)throw new Error('mail unavailable');sent.push('customer');},
    invoiceEmail:async session=>{assert.equal(session.invoice_pdf_base64,Buffer.from('pdf').toString('base64'));sent.push('pdf');}};
  await assert.rejects(fulfill(sql,row,deps));await fulfill(sql,row,deps);await fulfill(sql,row,deps);
  assert.deepEqual(sent,['invoice','internal','customer','pdf']);assert.equal(pdfs,1);
  assert.ok((await sql`SELECT fulfilled_at FROM paypal_orders WHERE id=${row.id}`)[0].fulfilled_at);
});
test('an active fulfillment lease requests webhook redelivery rather than acknowledging lost work', async()=>{
  const row=await fixture();await sql`UPDATE paypal_orders SET status='paid',fulfillment_lock=NOW() WHERE id=${row.id}`;
  await assert.rejects(fulfill(sql,row),/läuft bereits/);
});

test('new Stripe checkouts lock out PayPal and another Stripe attempt until provider-confirmed release', async()=>{
  const row=await fixture();
  const selected=row.snapshot.items.map(i=>({id:i.id,product:{amount:i.price,stockVersion:i.version}}));
  const claim=await reserveStripeStock(sql,selected);
  await assert.rejects(claimStock(sql,row));
  await assert.rejects(reserveStripeStock(sql,selected));
  const freshItems=await sql`SELECT product_id AS id, name, price, updated_at::text AS version FROM products ORDER BY product_id`;
  const fresh={...row,snapshot:{...row.snapshot,items:freshItems}};
  await assert.rejects(claimStock(sql,fresh)); // conflict remains even after refreshing product versions
  await sql`UPDATE stripe_stock_claims SET session_id='cs_test_1' WHERE id=${claim}`;
  await releaseStripeStock(sql,'cs_test_1');
  await claimStock(sql,fresh);
  assert.equal((await sql`SELECT balance FROM vouchers`)[0].balance,0);
});
test('PayPal rollout waits for legacy Stripe sessions to expire', async()=>{
  await sql`UPDATE checkout_stock_guard SET started_at=NOW()`;assert.equal(await checkoutStockReady(sql),false);
  await sql`UPDATE checkout_stock_guard SET started_at=NOW()-INTERVAL '25 hours'`;assert.equal(await checkoutStockReady(sql),true);
});

test('market sale respects an open Stripe checkout and succeeds after its confirmed release', async()=>{
  const row=await fixture();
  const claim=await reserveStripeStock(sql,row.snapshot.items.map(i=>({id:i.id,product:{amount:i.price,stockVersion:i.version}})));
  const sale={id:'market-sale-123',productId:'tasse-1',quantity:1,total:2500,payment:'Bar',way:'Mitgenommen',day:'2026-11-06',note:''};
  const version=(await sql`SELECT updated_at::text AS version FROM products WHERE product_id='tasse-1'`)[0].version;
  const req=post({action:'sale',sale,productVersion:version});
  let res=response();await marketHandler(req,res,sql);assert.equal(res.code,409);
  await sql`UPDATE stripe_stock_claims SET session_id='cs_market_1' WHERE id=${claim}`;
  await releaseStripeStock(sql,'cs_market_1');
  res=response();await marketHandler(req,res,sql);assert.equal(res.code,200);
  assert.equal((await sql`SELECT status FROM products WHERE product_id='tasse-1'`)[0].status,'sold');
});

test('sandbox accepts its branch preview origin and returns to that same test shop', async()=>{
  await fixture();const prior=process.env.VERCEL_BRANCH_URL;process.env.VERCEL_BRANCH_URL='shop-git-paypal-example.vercel.app';
  let payload;const req=post({action:'create',items:[{id:'tasse-1'}]});req.headers.origin='https://'+process.env.VERCEL_BRANCH_URL;
  const res=response();
  try{await paypalCheckout(req,res,{cfg,sql,api:async(_cfg,_path,options)=>{payload=options.body;return{id:'PREVIEWORDER123'};}});}
  finally{if(prior===undefined)delete process.env.VERCEL_BRANCH_URL;else process.env.VERCEL_BRANCH_URL=prior;}
  assert.equal(res.code,200);
  assert.equal(payload.payment_source.paypal.experience_context.return_url,req.headers.origin+'/?paypal=return');
  assert.equal(payload.payment_source.paypal.experience_context.cancel_url,req.headers.origin+'/?paypal=cancel');
});

test.after(async()=>{await db.close();});
