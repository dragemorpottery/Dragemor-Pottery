import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createInvoicePdf, sendInternalOrderEmail, sendCustomerOrderEmail, sendInvoiceEmail } from '../lib/order-fulfillment.js';

test('shared Stripe/PayPal receipt produces a PDF and sends the existing messages with PayPal idempotency',async()=>{
  const session={id:'paypal_TEST1234567',invoice_date:'2026-11-04T12:00:00Z',payment_status:'paid',amount_subtotal:2500,amount_total:1699,
    total_details:{amount_shipping:699,amount_discount:1500},customer_details:{name:'Kundin <Test>',email:'test@example.test',address:{line1:'Testweg 1',postal_code:'24803',city:'Tielen',country:'DE'}},
    email_keys:{internal:'internal-1',customer:'customer-1',invoice:'invoice-1'}};
  const items=[{description:'Tasse <Unikat>',quantity:1,amount_subtotal:2500,amount_total:2500}];
  const bytes=await createInvoicePdf(session,items,'DP-2026-0001');
  assert.equal((await PDFDocument.load(bytes)).getPageCount(),1);
  session.invoice_pdf_base64=bytes.toString('base64');
  const original=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');calls.push({headers:options.headers,body:JSON.parse(options.body)});return{ok:true};};
  try{await sendInternalOrderEmail(session,items);await sendCustomerOrderEmail(session,items);await sendInvoiceEmail(session,items,'DP-2026-0001');}
  finally{globalThis.fetch=original;}
  assert.equal(calls.length,3);assert.deepEqual(calls.map(c=>c.headers['Idempotency-Key']),['internal-1','customer-1','invoice-1']);
  assert.match(calls[1].body.html,/Tasse &lt;Unikat&gt;/);assert.match(calls[1].body.text,/Tasse <Unikat>/);
  assert.equal(calls[2].body.attachments[0].content,session.invoice_pdf_base64);
});
