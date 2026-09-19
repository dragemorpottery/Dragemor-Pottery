import crypto from 'crypto';

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    );
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

  // Stripe empfiehlt, alte signierte Nachrichten nicht unbegrenzt
  // zu akzeptieren. Hier: maximal 5 Minuten.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Methode nicht erlaubt.'
    });
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({
      error: 'Webhook ist noch nicht vollständig eingerichtet.'
    });
  }

  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers['stripe-signature'];

    const valid = verifyStripeSignature(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (!valid) {
      console.error('Ungültige Stripe-Webhook-Signatur.');

      return res.status(400).json({
        error: 'Ungültige Signatur.'
      });
    }

    const event = JSON.parse(rawBody.toString('utf8'));

    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object;

      console.log('Neue bezahlte Bestellung:', {
        sessionId: session?.id,
        paymentStatus: session?.payment_status,
        customerEmail: session?.customer_details?.email,
        amountTotal: session?.amount_total
      });
    }

    return res.status(200).json({
      received: true
    });

  } catch (error) {
    console.error('Stripe Webhook Fehler:', error);

    return res.status(400).json({
      error: 'Webhook konnte nicht verarbeitet werden.'
    });
  }
}
