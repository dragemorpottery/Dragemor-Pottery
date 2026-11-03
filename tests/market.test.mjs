import assert from 'node:assert/strict';
import {validSale,marketHandler,snapshot} from '../lib/market.js';
const sale={id:'test-sale-123',productId:'produkt-1',quantity:1,total:3250,payment:'SumUp',way:'Zur Abholung',day:'2026-11-06',note:'Abholung 17 Uhr'};
assert.equal(validSale(sale),true);
for(const change of [{quantity:2},{total:NaN},{total:3.2},{payment:'stripe'},{day:'2026-11-09'},{way:'available'},{note:'x'.repeat(1501)}])assert.equal(!!validSale({...sale,...change}),false);
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.code=n;return this},json(d){this.body=d;return this}});
let calls=0;const sql=async()=>{calls++;return []};
let r=response();await marketHandler({method:'POST',headers:{origin:'https://attacker.test','content-type':'application/json'},body:{action:'sale',sale}},r,sql);assert.equal(r.code,403);assert.equal(calls,0);
r=response();await marketHandler({method:'DELETE',headers:{}},r,sql);assert.equal(r.code,405);assert.equal(calls,0);
r=response();await marketHandler({method:'POST',headers:{origin:'https://dragemor-pottery.de','content-type':'text/plain'},body:{}},r,sql);assert.equal(r.code,415);assert.equal(calls,0);
r=response();await marketHandler({method:'POST',headers:{origin:'https://dragemor-pottery.de','content-type':'application/json'},body:{action:'sale',sale:{...sale,quantity:2},productVersion:'2026-11-03T10:00:00Z'}},r,sql);assert.equal(r.code,400);assert.equal(calls,1); // schema only, no stock write
let index=0;const historical={...sale,id:'old-sale',productId:'deleted-product',category:'Keramik',name:'Historische Tasse'};
const snap=await snapshot(async()=>++index===1?[{product_id:'leder-1',name:'Gürtel',category:'Accessoires',price:'3250',status:'available',shop_version:'2026-11-03 11:00:00.123456+00'},{product_id:'produkt-2',name:'Tasse',category:'Momente des Innehaltens',price:2800,status:'sold',shop_version:'x'}]:[{payload:historical}]);
assert.equal(snap.products[0].price,3250);assert.equal(snap.products[0].quantity,1);assert.equal(snap.products[0].category,'Leder');assert.equal(snap.products[0].shopVersion,'2026-11-03 11:00:00.123456+00');assert.equal(snap.products[1].quantity,0);assert.equal(snap.products[1].category,'Keramik');assert.equal(snap.products[2].quantity,0);assert.equal(snap.sales[0].productId,snap.products[2].id);
console.log('PASS: sale validation, CSRF/content-type/method guards, cents, categories, exact versions, deleted-product history');
