import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../paypal-checkout.js',import.meta.url),'utf8');
function harness({enabled=true,pending=null,result='paid',search=''}={}) {
  const nodes=new Map(); const requests=[];let redirect, cleanedUrl;
  function node(id) {if(!nodes.has(id))nodes.set(id,{hidden:true,disabled:false,textContent:'',style:{setProperty(k,v){this[k]=v;}},classList:{contains:()=>true,add(){}},setAttribute(){},addEventListener(k,v){this[k]=v;}});return nodes.get(id);}
  const saved=new Map(pending?[['dragemorPayPalPending',JSON.stringify(pending)]]:[]);
  const storage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
  const context={console,Set,JSON,URL,sessionStorage:storage,
    location:{href:'https://www.dragemor-pottery.de/'+search,assign(url){redirect=url;}},
    history:{replaceState(_state,_title,url){cleanedUrl=url.href;}},
    addEventListener(){},openCart(){context.refreshPayPalCheckout(false);},localStorage:{...storage},dragemorCart:[{id:'tasse-1'},{id:'extra'}],dragemorVoucher:{code:'DRG-TEST-15'},saveVoucher(){},clearPreparedStripeCheckout(){},renderCart(){},closeCart(){},
    document:{getElementById:node,body:{style:{}}},
    fetch:async(_url,opts)=>{if(!opts?.method)return{ok:true,json:async()=>({enabled,clientId:'public-client'})};
      const body=JSON.parse(opts.body);requests.push(body);return{ok:true,json:async()=>body.action==='create'?{orderId:'PAYPALORDER123',token:'a'.repeat(64),approvalUrl:'https://www.paypal.com/checkoutnow?token=PAYPALORDER123'}:{status:result}};}};
  context.window=context;vm.createContext(context);vm.runInContext(source,context);
  return{context,node,requests,saved,get redirect(){return redirect},get cleanedUrl(){return cleanedUrl},async open(){context.refreshPayPalCheckout(false);await new Promise(r=>setImmediate(r));}};
}
test('one click stores the recovery state and opens PayPal',async()=>{
  const off=harness({enabled:false});await off.open();
  assert.equal(off.node('paypalCheckout').hidden,true);
  const h=harness();await h.open();
  assert.equal(h.node('paypalCheckout').hidden,false);
  await h.node('paypalChoose').click();
  assert.equal(h.redirect,'https://www.paypal.com/checkoutnow?token=PAYPALORDER123');
  assert.equal(h.requests[0].voucherCode,'DRG-TEST-15');
  assert.equal(JSON.parse(h.saved.get('dragemorPayPalPending')).orderId,'PAYPALORDER123');
  await h.node('paypalChoose').click();
  assert.equal(h.requests.length,1);
});
test('matching PayPal return completes automatically and preserves unrelated cart items',async()=>{
  const pending={orderId:'PAYPALORDER123',token:'a'.repeat(64),items:[{id:'tasse-1'}],voucherCode:'DRG-TEST-15'};
  const h=harness({pending,search:'?paypal=return&token=PAYPALORDER123&PayerID=buyer#shop'});
  await h.open();
  assert.equal(h.requests[0].action,'capture');
  assert.equal(h.cleanedUrl,'https://www.dragemor-pottery.de/#shop');
  assert.deepEqual(JSON.parse(JSON.stringify(h.context.dragemorCart)),[{id:'extra'}]);
  assert.equal(h.context.dragemorVoucher,null);
  assert.equal(h.saved.has('dragemorPayPalPending'),false);
  const mismatch=harness({pending,search:'?paypal=return&token=OTHER'});
  await mismatch.open();
  assert.equal(mismatch.requests.length,0);
  assert.equal(mismatch.node('paypalRetry').hidden,false);
});
test('pending payment survives reload and preserves the cart; cancellation is confirmed by the server',async()=>{
  const pending={orderId:'PAYPALORDER123',token:'a'.repeat(64),items:[{id:'tasse-1'}],voucherCode:''};
  const h=harness({pending,result:'pending'});await h.open();
  assert.equal(h.node('paypalChoose').disabled,true);await h.node('paypalRetry').click();
  assert.equal(h.requests[0].action,'capture');assert.equal(h.context.dragemorCart.length,2);assert.ok(h.saved.has('dragemorPayPalPending'));
  const c=harness({pending,result:'cancelled'});await c.open();await c.node('paypalCancel').click();
  assert.equal(c.requests[0].action,'cancel');assert.equal(c.context.dragemorCart.length,2);assert.equal(c.saved.has('dragemorPayPalPending'),false);
});
