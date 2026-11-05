import { releaseStripeStock } from '../lib/checkout-stock.js';
import { ensureVoucherTables } from '../lib/vouchers.js';
import { createInvoice, sendInternalOrderEmail, sendCustomerOrderEmail, sendInvoiceEmail, orderNumberFromInvoice } from '../lib/order-fulfillment.js';
import { paypalWebhook } from '../lib/paypal.js';
import crypto from 'crypto';

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function verifyStripeSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const parts = signatureHeader.split(',');
  const timestampPart = parts.find(part => part.startsWith('t='));

  const signatures = parts
    .filter(part => part.startsWith('v1='))
    .map(part => part.slice(3));

  if (!timestampPart || !signatures.length) return false;

  const timestamp = timestampPart.slice(2);

  const age =
    Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));

  if (!Number.isFinite(age) || age > 300) return false;

  const signedPayload =
    `${timestamp}.${payload.toString('utf8')}`;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  return signatures.some(signature => {
    try {
      const a = Buffer.from(signature, 'hex');
      const b = Buffer.from(expectedSignature, 'hex');

      return (
        a.length === b.length &&
        crypto.timingSafeEqual(a, b)
      );
    } catch {
      return false;
    }
  });
}

async function getStripeLineItems(sessionId, livemode = true) {
  const stripeSecretKey = livemode
    ? process.env.STRIPE_SECRET_KEY
    : (process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY);

  if (!stripeSecretKey) {
    throw new Error(
      'STRIPE_SECRET_KEY ist nicht eingerichtet.'
    );
  }

  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(
      sessionId
    )}/line_items?limit=100`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
      },
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Stripe-Positionen konnten nicht geladen werden: ${
        data?.error?.message || 'Unbekannter Fehler'
      }`
    );
  }

  return Array.isArray(data?.data) ? data.data : [];
}

async function markProductsAsSold(productIds) {
if (!productIds?.length) return;

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL ist nicht eingerichtet.');
  }

  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(databaseUrl);

  await sql`
    UPDATE products
    SET
      status = 'sold',
      updated_at = NOW()
    WHERE product_id = ANY(${productIds})
  `;
} 

async function releaseVoucherReservationFromSession(session) {
  const code = session?.metadata?.dragemor_voucher_code;
  const token = session?.metadata?.dragemor_voucher_reservation;
  if (!code || !token || !process.env.DATABASE_URL) return;

  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  await ensureVoucherTables(sql);

  await sql`
    UPDATE vouchers
    SET
      reserved_amount = 0,
      reservation_token = NULL,
      reserved_session_id = NULL,
      reserved_until = NULL,
      updated_at = NOW()
    WHERE code = ${code}
      AND reservation_token = ${token}
  `;
}

async function redeemVoucherFromSession(session) {
  const code = session?.metadata?.dragemor_voucher_code;
  const token = session?.metadata?.dragemor_voucher_reservation;
  const amount = Number(session?.metadata?.dragemor_voucher_amount || 0);

  if (!code || !token || !Number.isInteger(amount) || amount <= 0) return;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ist nicht eingerichtet.');

  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  await ensureVoucherTables(sql);

  const result = await sql`
    WITH inserted AS (
      INSERT INTO voucher_redemptions (
        stripe_session_id,
        voucher_code,
        amount
      )
      SELECT
        ${session.id},
        v.code,
        ${amount}
      FROM vouchers v
      WHERE v.code = ${code}
        AND v.reservation_token = ${token}
        AND v.reserved_amount = ${amount}
        AND v.balance >= ${amount}
      ON CONFLICT (stripe_session_id) DO NOTHING
      RETURNING voucher_code, amount
    ),
    updated AS (
      UPDATE vouchers v
      SET
        balance = v.balance - i.amount,
        status = CASE
          WHEN v.balance - i.amount <= 0 THEN 'redeemed'
          ELSE 'active'
        END,
        redeemed_at = CASE
          WHEN v.balance - i.amount <= 0 THEN NOW()
          ELSE v.redeemed_at
        END,
        reserved_amount = 0,
        reservation_token = NULL,
        reserved_session_id = NULL,
        reserved_until = NULL,
        updated_at = NOW()
      FROM inserted i
      WHERE v.code = i.voucher_code
      RETURNING v.code, v.balance, v.status
    )
    SELECT * FROM updated
  `;

  if (result.length) return;

  const alreadyProcessed = await sql`
    SELECT stripe_session_id
    FROM voucher_redemptions
    WHERE stripe_session_id = ${session.id}
    LIMIT 1
  `;

  if (alreadyProcessed.length) return;

  throw new Error('Gutschein konnte nach der Zahlung nicht verbucht werden.');
}
async function processPaidCheckoutSession(session) {
  if (!session?.id) {
    throw new Error('Stripe Session-ID fehlt.');
  }

  if (
  session?.payment_status !== 'paid' &&
  session?.payment_status !== 'no_payment_required'
) {
  return;
} 

  const lineItems = await getStripeLineItems(
    session.id,
    session?.livemode !== false
  );

  const productIds = (session?.metadata?.dragemor_product_ids || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  await markProductsAsSold(productIds);
  {
    const { neon } = await import('@neondatabase/serverless');
    await releaseStripeStock(neon(process.env.DATABASE_URL), session.id);
  }
  await redeemVoucherFromSession(session);

  const invoiceNumber = await createInvoice(session, lineItems);
  session.order_number = orderNumberFromInvoice(invoiceNumber);

  await sendInternalOrderEmail(session, lineItems);
  await sendCustomerOrderEmail(session, lineItems);
  await sendInvoiceEmail(session, lineItems, invoiceNumber);
}

export default async function handler(req, res) {
  if (req.query?.provider === 'paypal') return paypalWebhook(req, res);
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Methode nicht erlaubt.',
    });
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({
      error:
        'Webhook ist noch nicht vollständig eingerichtet.',
    });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({
      error:
        'Resend ist noch nicht vollständig eingerichtet.',
    });
  }

  try {
    const rawBody = await getRawBody(req);

    const signature =
      req.headers['stripe-signature'];

    const valid = verifyStripeSignature(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (!valid) {
      console.error(
        'Ungültige Stripe-Webhook-Signatur.'
      );

      return res.status(400).json({
        error: 'Ungültige Signatur.',
      });
    }

    const event =
      JSON.parse(rawBody.toString('utf8'));

    if (
      event.type === 'checkout.session.expired' ||
      event.type === 'checkout.session.async_payment_failed'
    ) {
      const releasedSession = event.data?.object;
      await releaseVoucherReservationFromSession(releasedSession);
      if (process.env.DATABASE_URL && releasedSession?.id) {
        const { neon } = await import('@neondatabase/serverless');
        await releaseStripeStock(neon(process.env.DATABASE_URL), releasedSession.id);
      }
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object;

      console.log('Stripe Checkout abgeschlossen:', {
        sessionId: session?.id,
        paymentStatus: session?.payment_status,
        productIds: session?.metadata?.dragemor_product_ids,
      });

    if (
  session?.payment_status === 'paid' ||
  session?.payment_status === 'no_payment_required'
) {
  await processPaidCheckoutSession(session);
} 
    }

    if (event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data?.object;

      console.log('Asynchrone Stripe-Zahlung erfolgreich:', {
        sessionId: session?.id,
        paymentStatus: session?.payment_status,
        productIds: session?.metadata?.dragemor_product_ids,
      });

      await processPaidCheckoutSession(session);
    }

    return res.status(200).json({
      received: true,
    });
  } catch (error) {
    console.error(
      'Stripe Webhook Fehler:',
      error
    );

    return res.status(500).json({
      error:
        'Webhook konnte nicht verarbeitet werden.',
    });
  }
}
