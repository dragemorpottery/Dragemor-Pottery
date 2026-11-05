import { ensureCheckoutStock, checkoutStockReady, refreshExpiredStripeClaims } from './checkout-stock.js';
import crypto from 'node:crypto';
import { ensureVoucherTables } from './vouchers.js';
import { createInvoice, sendInternalOrderEmail, sendCustomerOrderEmail, sendInvoiceEmail, createInvoicePdf } from './order-fulfillment.js';

const SHIPPING = 699;
const ORIGINS = ['https://dragemor-pottery.de', 'https://www.dragemor-pottery.de'];
const ID = /^[A-Z0-9]{10,32}$/;
const error = (message, status = 409) => Object.assign(new Error(message), { status });
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const money = cents => (cents / 100).toFixed(2);
const hash = token => crypto.createHash('sha256').update(String(token)).digest('hex');

export function settings(env = process.env) {
  // Preview must NEVER fall back to live credentials or a live PayPal endpoint.
  const sandbox = env.VERCEL_ENV === 'preview' || env.PAYPAL_ENV === 'sandbox';
  const prefix = sandbox ? 'PAYPAL_TEST_' : 'PAYPAL_';
  return {
    sandbox, clientId: env[prefix + 'CLIENT_ID'], secret: env[prefix + 'CLIENT_SECRET'],
    merchantId: env[prefix + 'MERCHANT_ID'], webhookId: env[prefix + 'WEBHOOK_ID'],
    base: sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com',
    enabled: env.PAYPAL_ENABLED === 'true' && !!env[sandbox ? 'PAYPAL_TEST_DATABASE_URL' : 'DATABASE_URL'] && !!env.RESEND_API_KEY &&
      ['CLIENT_ID', 'CLIENT_SECRET', 'MERCHANT_ID', 'WEBHOOK_ID'].every(k => !!env[prefix + k])
  };
}

export function validItems(items) {
  return Array.isArray(items) && items.length > 0 && items.length <= 20 &&
    items.every(i => typeof i?.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(i.id)) &&
    new Set(items.map(i => i.id)).size === items.length;
}

export function cents(value) {
  if (typeof value !== 'string' || !/^\d+\.\d{2}$/.test(value)) throw error('Ungültiger PayPal-Betrag.');
  const amount = Number(value.replace('.', ''));
  if (!Number.isSafeInteger(amount) || amount < 0) throw error('Ungültiger PayPal-Betrag.');
  return amount;
}

export async function paypalRequest(cfg, path, { method = 'GET', body, requestId } = {}) {
  if (!cfg.accessToken || cfg.tokenExpiresAt < Date.now()) {
    const auth = await fetch(cfg.base + '/v1/oauth2/token', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.secret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials'
    });
    const token = await auth.json();
    if (!auth.ok || !token.access_token) throw error('PayPal ist gerade nicht erreichbar. Bitte später erneut versuchen.', 502);
    cfg.accessToken = token.access_token;
    cfg.tokenExpiresAt = Date.now() + Math.max(0, Number(token.expires_in || 300) - 30) * 1000;
  }
  const response = await fetch(cfg.base + path, {
    method, signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + cfg.accessToken, 'Content-Type': 'application/json',
      Prefer: 'return=representation', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Do not expose provider responses, customer information or credentials to the browser.
    console.error('PayPal API error', { status: response.status, name: data.name, debugId: data.debug_id });
    throw error('PayPal konnte den Vorgang noch nicht bestätigen. Bitte Zahlungsstatus erneut prüfen.', 502);
  }
  return data;
}

async function database(cfg) {
  const { neon } = await import('@neondatabase/serverless');
  return neon(cfg.sandbox ? process.env.PAYPAL_TEST_DATABASE_URL : process.env.DATABASE_URL);
}

export async function ensureTables(sql) {
  await sql`CREATE TABLE IF NOT EXISTS paypal_orders (
    id TEXT PRIMARY KEY, checkout_id TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL,
    sandbox BOOLEAN NOT NULL, snapshot JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'created',
    capture_id TEXT UNIQUE, claim_version TIMESTAMPTZ, paid_session JSONB,
    invoice_number TEXT, invoice_pdf_base64 TEXT, internal_sent BOOLEAN NOT NULL DEFAULT FALSE,
    customer_sent BOOLEAN NOT NULL DEFAULT FALSE, invoice_sent BOOLEAN NOT NULL DEFAULT FALSE,
    fulfillment_lock TIMESTAMPTZ, fulfilled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await ensureVoucherTables(sql);
  await ensureCheckoutStock(sql);
}

async function getOrder(sql, id, sandbox) {
  if (typeof id !== 'string' || !ID.test(id)) throw error('Ungültige PayPal-Bestellung.', 400);
  const rows = await sql`SELECT * FROM paypal_orders WHERE id = ${id} AND sandbox = ${sandbox}`;
  if (!rows.length) throw error('PayPal-Bestellung nicht gefunden.', 404);
  return { ...rows[0], snapshot: json(rows[0].snapshot) };
}

export function checkOrder(order, row, cfg) {
  const unit = order.purchase_units?.[0];
  if (order.id !== row.id || order.intent !== 'CAPTURE' || order.purchase_units?.length !== 1 ||
      unit.custom_id !== row.checkout_id || unit.payee?.merchant_id !== cfg.merchantId ||
      unit.amount?.currency_code !== 'EUR' || cents(unit.amount?.value) !== row.snapshot.total) {
    throw error('PayPal-Bestellung konnte nicht sicher zugeordnet werden.');
  }
  if (unit.shipping?.address?.country_code !== 'DE') {
    throw error('Versand ist ausschließlich innerhalb Deutschlands möglich.');
  }
  return unit;
}

export function paidSession(order, row, cfg) {
  const unit = checkOrder(order, row, cfg);
  const captures = unit.payments?.captures || [];
  const capture = captures[0];
  if (captures.length !== 1 || capture?.status !== 'COMPLETED' ||
      capture.final_capture !== true || !ID.test(capture.id) ||
      capture.amount?.currency_code !== 'EUR' || cents(capture.amount?.value) !== row.snapshot.total) return null;
  const addr = unit.shipping.address;
  const payer = order.payment_source?.paypal?.email_address ? order.payment_source.paypal : (order.payer || {});
  if (!payer.email_address) throw error('PayPal hat keine E-Mail-Adresse übermittelt.');
  return {
    invoice_date: capture.create_time || new Date().toISOString(),
    id: 'paypal_' + order.id, payment_status: 'paid', payment_method: 'paypal',
    amount_subtotal: row.snapshot.subtotal, amount_total: row.snapshot.total,
    total_details: { amount_shipping: SHIPPING, amount_discount: row.snapshot.discount },
    customer_details: { email: payer.email_address,
      name: unit.shipping.name?.full_name || [payer.name?.given_name, payer.name?.surname].filter(Boolean).join(' '),
      address: { line1: addr.address_line_1 || '', line2: addr.address_line_2 || '',
        postal_code: addr.postal_code || '', city: addr.admin_area_2 || '', country: addr.country_code } }
  };
}

async function createOrder(sql, cfg, body, api) {
  if (!validItems(body.items)) throw error('Ungültiger oder leerer Warenkorb.', 400);
  const ids = body.items.map(i => i.id);
  const products = await sql`SELECT product_id, name, price, status, updated_at::text AS version
    FROM products WHERE product_id = ANY(${ids}) ORDER BY product_id`;
  if (products.length !== ids.length || products.some(p => p.status !== 'available' ||
      !Number.isSafeInteger(Number(p.price)) || Number(p.price) <= 0 || !p.name)) {
    throw error('Mindestens ein Artikel ist nicht mehr verfügbar. Bitte Warenkorb aktualisieren.');
  }
  const tombstoneTable = await sql`SELECT to_regclass('public.deleted_products') AS relation`;
  if (tombstoneTable[0]?.relation) {
    const removed = await sql`SELECT product_id FROM deleted_products WHERE product_id = ANY(${ids})`;
    if (removed.length) throw error('Ein Artikel wurde aus dem Sortiment entfernt.');
  }
  const items = products.map(p => ({ id: p.product_id, name: p.name, price: Number(p.price), version: p.version }));
  const subtotal = items.reduce((sum, i) => sum + i.price, 0);
  if (!Number.isSafeInteger(subtotal) || subtotal > 100000000) throw error('Ungültiger Bestellbetrag.', 400);
  let voucher = null;
  const code = String(body.voucherCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 80);
  if (code) {
    const vouchers = await sql`SELECT code, balance, status,
      (reservation_token IS NOT NULL AND reserved_until > NOW()) AS reserved
      FROM vouchers WHERE regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') = ${code} LIMIT 1`;
    const v = vouchers[0];
    if (!v || v.status !== 'active' || Number(v.balance) <= 0 || v.reserved) {
      throw error('Gutschein ist nicht verfügbar oder in einem anderen Bezahlvorgang vorgemerkt.');
    }
    voucher = { code: v.code, amount: Math.min(Number(v.balance), subtotal) };
  }
  const snapshot = { items, subtotal, discount: voucher?.amount || 0,
    total: subtotal + SHIPPING - (voucher?.amount || 0), voucher };
  const checkoutId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const result = await api(cfg, '/v2/checkout/orders', { method: 'POST', requestId: checkoutId, body: {
    intent: 'CAPTURE', purchase_units: [{ custom_id: checkoutId, payee: { merchant_id: cfg.merchantId },
      description: 'Dragemor Pottery – handgemachte Unikate',
      amount: { currency_code: 'EUR', value: money(snapshot.total), breakdown: {
        item_total: { currency_code: 'EUR', value: money(subtotal) },
        shipping: { currency_code: 'EUR', value: money(SHIPPING) },
        ...(voucher ? { discount: { currency_code: 'EUR', value: money(voucher.amount) } } : {})
      } }, items: items.map(i => ({ name: i.name.slice(0, 127), sku: i.id, quantity: '1',
        category: 'PHYSICAL_GOODS', unit_amount: { currency_code: 'EUR', value: money(i.price) } }))
    }], payment_source: { paypal: { experience_context: {
      brand_name: 'Dragemor Pottery', locale: 'de-DE', shipping_preference: 'GET_FROM_FILE', user_action: 'PAY_NOW',
      return_url: (cfg.checkoutOrigin || ORIGINS[0]) + '/?paypal=return',
      cancel_url: (cfg.checkoutOrigin || ORIGINS[0]) + '/?paypal=cancel'
    } } }
  } });
  if (!ID.test(result.id)) throw error('PayPal hat keine gültige Bestellnummer geliefert.', 502);
  await sql`INSERT INTO paypal_orders (id, checkout_id, token_hash, sandbox, snapshot)
    VALUES (${result.id}, ${checkoutId}, ${hash(token)}, ${cfg.sandbox}, ${JSON.stringify(snapshot)}::jsonb)`;
  return { orderId: result.id, token };
}

export async function claimStock(sql, row) {
  const s = row.snapshot;
  // One SQL statement claims ALL products and any voucher together. Other shop/market
  // writers see sold immediately. A stale product version/price aborts before PayPal capture.
  const result = await sql`WITH locked_order AS MATERIALIZED (
    SELECT id FROM paypal_orders WHERE id = ${row.id} AND status = 'created' FOR UPDATE
  ), stock AS MATERIALIZED (
    SELECT p.product_id, p.status, p.price, p.updated_at FROM products p
    JOIN jsonb_to_recordset(${JSON.stringify(s.items)}::jsonb) AS wanted(id text, price integer, version text)
      ON p.product_id = wanted.id
    ORDER BY p.product_id FOR UPDATE OF p
  ), voucher AS MATERIALIZED (
    SELECT * FROM vouchers WHERE code = ${s.voucher?.code || ''} FOR UPDATE
  ), eligible AS (
    SELECT 1 WHERE EXISTS (SELECT 1 FROM locked_order)
      AND (SELECT COUNT(*) FROM stock) = ${s.items.length}
      AND NOT EXISTS (SELECT 1 FROM stock p
        JOIN jsonb_to_recordset(${JSON.stringify(s.items)}::jsonb) AS wanted(id text, price integer, version text)
          ON p.product_id = wanted.id
        WHERE p.status <> 'available' OR p.price <> wanted.price OR p.updated_at <> wanted.version::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM stripe_stock_claims WHERE status = 'active'
        AND product_ids && ${s.items.map(i => i.id)}::text[])
      AND (${!s.voucher} OR EXISTS (SELECT 1 FROM voucher WHERE status = 'active'
        AND balance >= ${s.discount} AND (reservation_token IS NULL OR reserved_until IS NULL OR reserved_until < NOW())))
  ), claimed AS (
    UPDATE products SET status = 'sold', updated_at = NOW()
    WHERE product_id IN (SELECT product_id FROM stock) AND EXISTS (SELECT 1 FROM eligible) RETURNING product_id
  ), redeemed AS (
    UPDATE vouchers SET balance = balance - ${s.discount},
      status = CASE WHEN balance - ${s.discount} = 0 THEN 'redeemed' ELSE 'active' END,
      redeemed_at = CASE WHEN balance - ${s.discount} = 0 THEN NOW() ELSE redeemed_at END,
      reserved_amount = 0, reservation_token = NULL, reserved_session_id = NULL, reserved_until = NULL, updated_at = NOW()
    WHERE code = ${s.voucher?.code || ''} AND EXISTS (SELECT 1 FROM eligible) RETURNING code
  ), ledger AS (
    INSERT INTO voucher_redemptions (stripe_session_id, voucher_code, amount)
    SELECT ${'paypal_' + row.id}, code, ${s.discount} FROM redeemed RETURNING voucher_code
  ) UPDATE paypal_orders SET status = 'capturing', claim_version = NOW(), updated_at = NOW()
    WHERE id = ${row.id} AND EXISTS (SELECT 1 FROM eligible) RETURNING id`;
  if (!result.length) throw error('Artikel oder Gutschein wurde inzwischen verkauft, geändert oder verwendet. Es wurde keine neue Abbuchung gestartet.');
}

export async function releaseDenied(sql, row) {
  // Only call after an authenticated PayPal GET shows a final DECLINED/FAILED capture.
  // Never release an uncertain/pending payment; it may still settle successfully.
  await sql`WITH locked AS MATERIALIZED (
    SELECT * FROM paypal_orders WHERE id = ${row.id} AND status = 'capturing' FOR UPDATE
  ), restored AS (
    UPDATE products p SET status = 'available', updated_at = NOW() FROM locked o
    WHERE p.product_id IN (SELECT x->>'id' FROM jsonb_array_elements(o.snapshot->'items') x)
      AND p.status = 'sold' AND p.updated_at = o.claim_version RETURNING p.product_id
  ), removed AS (
    DELETE FROM voucher_redemptions WHERE stripe_session_id = ${'paypal_' + row.id}
      AND EXISTS (SELECT 1 FROM locked) RETURNING voucher_code, amount
  ), credited AS (
    UPDATE vouchers v SET balance = v.balance + r.amount,
      status = CASE WHEN v.status = 'redeemed' THEN 'active' ELSE v.status END, updated_at = NOW()
    FROM removed r WHERE v.code = r.voucher_code RETURNING v.code
  ) UPDATE paypal_orders SET status = 'denied', updated_at = NOW()
    WHERE id = ${row.id} AND EXISTS (SELECT 1 FROM locked)`;
}

export async function fulfill(sql, row, {
  makeInvoice = createInvoice, makePdf = createInvoicePdf,
  internalEmail = sendInternalOrderEmail, customerEmail = sendCustomerOrderEmail, invoiceEmail = sendInvoiceEmail
} = {}) {
  // A lease serializes capture responses and webhook retries. Every completed step is durable.
  const locked = await sql`UPDATE paypal_orders SET fulfillment_lock = NOW(), updated_at = NOW()
    WHERE id = ${row.id} AND status = 'paid' AND fulfilled_at IS NULL
      AND (fulfillment_lock IS NULL OR fulfillment_lock < NOW() - INTERVAL '5 minutes') RETURNING *`;
  if (!locked.length) {
    const existing = await sql`SELECT fulfilled_at FROM paypal_orders WHERE id = ${row.id}`;
    if (existing[0]?.fulfilled_at) return;
    throw error('Bestellverarbeitung läuft bereits. Die PayPal-Rückmeldung wird erneut verarbeitet.', 503);
  }
  let current = locked[0];
  const session = json(current.paid_session);
  const lineItems = row.snapshot.items.map(i => ({ description: i.name, quantity: 1, amount_subtotal: i.price, amount_total: i.price }));
  // Resend idempotency keys also cover a network loss between sending and checkpointing.
  // The database keeps the payload/date stable across retries (including the invoice PDF).
  session.email_keys = { internal: 'paypal-internal-' + row.id, customer: 'paypal-customer-' + row.id,
    invoice: 'paypal-invoice-' + row.id };
  try {
    const invoiceNumber = current.invoice_number || await makeInvoice(session, lineItems, sql);
    await sql`UPDATE paypal_orders SET invoice_number = ${invoiceNumber} WHERE id = ${row.id}`;
    if (!current.internal_sent) {
      await internalEmail(session, lineItems);
      await sql`UPDATE paypal_orders SET internal_sent = TRUE WHERE id = ${row.id}`;
    }
    if (!current.customer_sent) {
      await customerEmail(session, lineItems);
      await sql`UPDATE paypal_orders SET customer_sent = TRUE WHERE id = ${row.id}`;
    }
    if (!current.invoice_sent) {
      session.invoice_pdf_base64 = current.invoice_pdf_base64;
      if (!session.invoice_pdf_base64) {
        session.invoice_pdf_base64 = (await makePdf(session, lineItems, invoiceNumber)).toString('base64');
        await sql`UPDATE paypal_orders SET invoice_pdf_base64 = ${session.invoice_pdf_base64} WHERE id = ${row.id}`;
      }
      await invoiceEmail(session, lineItems, invoiceNumber);
      await sql`UPDATE paypal_orders SET invoice_sent = TRUE WHERE id = ${row.id}`;
    }
    await sql`UPDATE paypal_orders SET fulfilled_at = NOW(), fulfillment_lock = NULL WHERE id = ${row.id}`;
  } catch (e) {
    await sql`UPDATE paypal_orders SET fulfillment_lock = NULL WHERE id = ${row.id}`;
    throw e;
  }
}

export async function reconcile(sql, row, cfg, order, { fulfillOrder = fulfill } = {}) {
  const unit = checkOrder(order, row, cfg);
  const session = paidSession(order, row, cfg);
  if (session) {
    if (!['capturing', 'paid'].includes(row.status)) throw error('PayPal-Zahlung ohne Bestandszuordnung. Bitte Bestellung prüfen.', 500);
    const capture = unit.payments.captures[0];
    await sql`UPDATE paypal_orders SET status = 'paid', capture_id = ${capture.id},
      paid_session = COALESCE(paid_session, ${JSON.stringify(session)}::jsonb), updated_at = NOW()
      WHERE id = ${row.id} AND status IN ('capturing', 'paid')`;
    await fulfillOrder(sql, row);
    return { status: 'paid', orderId: row.id };
  }
  const captures = unit.payments?.captures || [];
  if (captures.length === 1 && ['DECLINED', 'FAILED'].includes(captures[0].status) &&
      ID.test(captures[0].id || '') && captures[0].amount?.currency_code === 'EUR' &&
      cents(captures[0].amount?.value) === row.snapshot.total) {
    await releaseDenied(sql, row);
    return { status: 'denied', orderId: row.id };
  }
  return { status: row.status === 'created' ? 'created' : 'pending', orderId: row.id };
}

export async function paypalCheckout(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  const cfg = deps.cfg || settings();
  if (req.method === 'GET') {
    let enabled = cfg.enabled;
    if (enabled && !cfg.sandbox) {
      try {
        const sql = deps.sql || await database(cfg);
        await ensureTables(sql);
        enabled = await checkoutStockReady(sql);
      } catch { enabled = false; }
    }
    return res.status(200).json({ enabled, ...(enabled ? { clientId: cfg.clientId } : {}) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  const allowed = [...ORIGINS];
  if (cfg.sandbox) {
    for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) {
      if (host) allowed.push('https://' + host);
    }
  }
  if (!allowed.includes(req.headers.origin)) return res.status(403).json({ error: 'Bitte Zahlung über den Shop starten.' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'JSON erforderlich.' });
  if (!cfg.enabled) return res.status(503).json({ error: 'PayPal ist noch nicht freigeschaltet.' });
  const body = req.body || {};
  const api = deps.api || paypalRequest;
  try {
    if (!['create', 'capture', 'status', 'cancel'].includes(body.action)) throw error('Unbekannte PayPal-Aktion.', 400);
    const sql = deps.sql || await database(cfg);
    await ensureTables(sql);
    if (body.action === 'create' && !cfg.sandbox && !await checkoutStockReady(sql)) {
      throw error('PayPal wird noch vorbereitet. Bitte wähle vorerst eine andere Zahlungsart.', 503);
    }
    if (['create', 'capture'].includes(body.action)) await refreshExpiredStripeClaims(sql, cfg.sandbox);
    if (body.action === 'create') return res.status(200).json(await createOrder(sql, { ...cfg, checkoutOrigin: req.headers.origin }, body, api));
    let row = await getOrder(sql, body.orderId, cfg.sandbox);
    const supplied = hash(body.token || '');
    if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token) ||
        !crypto.timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(supplied, 'hex'))) throw error('Ungültige Zahlungssitzung.', 403);
    if (row.status === 'cancelled') return res.status(200).json({ status: 'cancelled', orderId: row.id });
    if (body.action === 'cancel') {
      const cancelled = await sql`UPDATE paypal_orders SET status = 'cancelled', updated_at = NOW()
        WHERE id = ${row.id} AND status = 'created' RETURNING id`;
      if (cancelled.length) return res.status(200).json({ status: 'cancelled', orderId: row.id });
      row = await getOrder(sql, row.id, cfg.sandbox);
    }
    if (row.status === 'denied') return res.status(200).json({ status: 'denied', orderId: row.id });
    let order = await api(cfg, '/v2/checkout/orders/' + row.id);
    checkOrder(order, row, cfg);
    if (body.action === 'capture' && row.status === 'created') {
      if (order.status !== 'APPROVED') throw error('Die Zahlung wurde noch nicht bei PayPal bestätigt.');
      await claimStock(sql, row);
      row = await getOrder(sql, row.id, cfg.sandbox);
    }
    if (body.action === 'capture' && row.status === 'capturing' && order.status === 'APPROVED') {
      // The stable key is reused after timeouts; never start a second capture with a new key.
      await api(cfg, '/v2/checkout/orders/' + row.id + '/capture', {
        method: 'POST', requestId: row.checkout_id + '-capture', body: {}
      });
      order = await api(cfg, '/v2/checkout/orders/' + row.id);
    }
    return res.status(200).json(await reconcile(sql, row, cfg, order, {
      ...deps, fulfillOrder: deps.fulfillOrder || (async () => {})
    }));
  } catch (e) {
    console.error('PayPal checkout', { status: e.status || 500, message: e.message });
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Zahlung wird noch geprüft. Bitte Zahlungsstatus erneut prüfen.' });
  }
}

export async function paypalWebhook(req, res, deps = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  const cfg = deps.cfg || settings();
  // Continue processing existing orders if PAYPAL_ENABLED is later turned off.
  if (!cfg.secret || !cfg.clientId || !cfg.webhookId || !cfg.merchantId) return res.status(503).json({ error: 'PayPal ist noch nicht eingerichtet.' });
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 262144) return res.status(413).json({ error: 'Nachricht zu groß.' });
      chunks.push(Buffer.from(chunk));
    }
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const headers = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
    if (headers.some(k => typeof req.headers[k] !== 'string')) return res.status(400).json({ error: 'Signatur fehlt.' });
    const api = deps.api || paypalRequest;
    const verified = await api(cfg, '/v1/notifications/verify-webhook-signature', { method: 'POST', body: {
      auth_algo: req.headers['paypal-auth-algo'], cert_url: req.headers['paypal-cert-url'],
      transmission_id: req.headers['paypal-transmission-id'], transmission_sig: req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'], webhook_id: cfg.webhookId, webhook_event: event
    } });
    if (verified.verification_status !== 'SUCCESS') return res.status(400).json({ error: 'Ungültige Signatur.' });
    if (!['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED'].includes(event.event_type)) return res.status(200).json({ received: true });
    const id = event.resource?.supplementary_data?.related_ids?.order_id;
    if (!ID.test(id || '')) throw error('Bestellnummer fehlt.', 400);
    const sql = deps.sql || await database(cfg);
    await ensureTables(sql);
    const rows = await sql`SELECT id FROM paypal_orders WHERE id = ${id} AND sandbox = ${cfg.sandbox}`;
    // This app may also be used outside this shop; ignore unknown orders.
    if (!rows.length) return res.status(200).json({ received: true });
    const row = await getOrder(sql, id, cfg.sandbox);
    const order = await api(cfg, '/v2/checkout/orders/' + id);
    await reconcile(sql, row, cfg, order, deps);
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('PayPal webhook', { status: e.status || 500, message: e.message });
    return res.status(500).json({ error: 'PayPal-Nachricht konnte noch nicht verarbeitet werden.' });
  }
}
