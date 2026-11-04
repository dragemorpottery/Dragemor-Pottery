import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../paypal-checkout.js',import.meta.url),'utf8');
function harness({enabled=true,pending=null,result='paid'}={}) {
  const nodes=new Map(); const requests=[];let sdkLoads=0,options;
  function node(id) {if(!nodes.has(id))nodes.set(id,{hidden:true,disabled:false,textContent:'',style:{setProperty(k,v){this[k]=v;}},classList:{contains:()=>true,add(){}},setAttribute(){},addEventListener(k,v){this[k]=v;}});return nodes.get(id);}
  const saved=new Map(pending?[['dragemorPayPalPending',JSON.stringify(pending)]]:[]);
  const storage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
  const context={console,Set,JSON,sessionStorage:storage,localStorage:{...storage},dragemorCart:[{id:'tasse-1'},{id:'extra'}],dragemorVoucher:{code:'DRG-TEST-15'},saveVoucher(){},clearPreparedStripeCheckout(){},renderCart(){},closeCart(){},
    document:{getElementById:node,createElement:()=>({dataset:{}}),head:{appendChild(script){sdkLoads++;script.onload();}},body:{style:{}}},
    fetch:async(_url,opts)=>{if(!opts?.method)return{ok:true,json:async()=>({enabled,clientId:'public-client'})};
      const body=JSON.parse(opts.body);requests.push(body);return{ok:true,json:async()=>body.action==='create'?{orderId:'PAYPALORDER123',token:'a'.repeat(64)}:{status:result}};},
    dragemorPayPal:{FUNDING:{PAYPAL:'paypal'},Buttons(o){options=o;return{render:async()=>{}};}}};
  context.window=context;vm.createContext(context);vm.runInContext(source,context);
  return{context,node,requests,saved,get options(){return options},get sdkLoads(){return sdkLoads},async open(){context.refreshPayPalCheckout(false);await new Promise(r=>setImmediate(r));}};
}
test('disabled config hides PayPal; choosing PayPal is required before loading the SDK',async()=>{
  const off=harness({enabled:false});await off.open();assert.equal(off.node('paypalCheckout').hidden,true);assert.equal(off.sdkLoads,0);
  const h=harness();await h.open();assert.equal(h.node('paypalCheckout').hidden,false);assert.equal(h.sdkLoads,0);
  await h.node('paypalChoose').click();assert.equal(h.sdkLoads,1);assert.ok(h.options);
});
test('payment success removes only purchased products and clears recovery state',async()=>{
  const h=harness();await h.open();await h.node('paypalChoose').click();
  h.context.dragemorCart=[{id:'tasse-1'}];
  assert.equal(await h.options.createOrder(),'PAYPALORDER123');
  assert.equal(h.requests[0].voucherCode,'DRG-TEST-15');
  h.context.dragemorCart.push({id:'extra'});
  await h.options.onApprove({orderID:'PAYPALORDER123'});
  assert.deepEqual(JSON.parse(JSON.stringify(h.context.dragemorCart)),[{id:'extra'}]);
  assert.equal(h.context.dragemorVoucher,null);assert.equal(h.saved.has('dragemorPayPalPending'),false);
});
test('pending payment survives reload and preserves the cart; cancellation is confirmed by the server',async()=>{
  const pending={orderId:'PAYPALORDER123',token:'a'.repeat(64),items:[{id:'tasse-1'}],voucherCode:''};
  const h=harness({pending,result:'pending'});await h.open();
  assert.equal(h.node('paypalChoose').disabled,true);await h.node('paypalRetry').click();
  assert.equal(h.requests[0].action,'capture');assert.equal(h.context.dragemorCart.length,2);assert.ok(h.saved.has('dragemorPayPalPending'));
  const c=harness({pending,result:'cancelled'});await c.open();await c.node('paypalCancel').click();
  assert.equal(c.requests[0].action,'cancel');assert.equal(c.context.dragemorCart.length,2);assert.equal(c.saved.has('dragemorPayPalPending'),false);
});
