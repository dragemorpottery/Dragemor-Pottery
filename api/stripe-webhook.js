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

function euro(amount) {
  if (typeof amount !== 'number') {
    return '0,00 €';
  }

  return (
    (amount / 100)
      .toFixed(2)
      .replace('.', ',') + ' €'
  );
}

async function getStripeLineItems(sessionId) {
  const stripeSecretKey =
  process.env.STRIPE_TEST_SECRET_KEY ||
  process.env.STRIPE_SECRET_KEY;

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

async function sendResendEmail({
  to,
  subject,
  text,
  html,
}) {
  const body = {
    from:
      'Dragemor Pottery <kontakt@dragemor-pottery.de>',
    to: Array.isArray(to) ? to : [to],
    subject,
    text,
  };

  if (html) {
    body.html = html;
  }

  const response = await fetch(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        Authorization:
          `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `E-Mail konnte nicht gesendet werden: ${errorText}`
    );
  }
}

async function sendInternalOrderEmail(
  session,
  lineItems
) {
  const customer =
    session?.customer_details || {};

  const address =
    customer?.address || {};

  const products = lineItems
    .map(item => {
      return `${item.description || 'Artikel'} – ${euro(
        item.amount_total
      )}`;
    })
    .join('\n');

  const total = euro(session?.amount_total);

  const emailText = `
Neue bezahlte Bestellung bei Dragemor Pottery

Bestellnummer:
${session?.id || 'Nicht angegeben'}

Produkte:
${products || 'Nicht angegeben'}

Zwischensumme:
${euro(session?.amount_subtotal)}

Versand:
${euro(session?.total_details?.amount_shipping)}

Gesamtbetrag:
${total}

Kunde:
${customer?.name || 'Nicht angegeben'}

E-Mail:
${customer?.email || 'Nicht angegeben'}

Lieferadresse:
${address?.line1 || ''}
${address?.line2 || ''}
${address?.postal_code || ''} ${address?.city || ''}
${address?.country || ''}

Zahlungsstatus:
${session?.payment_status || 'Nicht angegeben'}
`.trim();

  await sendResendEmail({
    to: 'kontakt@dragemor-pottery.de',
    subject:
      `Neue Bestellung – Dragemor Pottery – ${total}`,
    text: emailText,
  });
}

async function sendCustomerOrderEmail(
  session,
  lineItems
) {
  const customer =
    session?.customer_details || {};

  const customerEmail =
    customer?.email || session?.customer_email;

  if (!customerEmail) {
    console.error(
      'Keine Kunden-E-Mail-Adresse vorhanden.'
    );
    return;
  }

  const firstName =
    customer?.name
      ?.trim()
      ?.split(/\s+/)[0] || '';

  const greeting =
    firstName
      ? `Hallo ${firstName},`
      : 'Hallo,';

  const productText = lineItems
    .map(item => {
      const quantity = item.quantity || 1;

      return `${
        item.description || 'Artikel'
      }${quantity > 1 ? ` × ${quantity}` : ''} – ${euro(
        item.amount_total
      )}`;
    })
    .join('\n');

  const productHtml = lineItems
    .map(item => {
      const quantity = item.quantity || 1;

      return `
        <tr>
          <td style="
            padding:10px 0;
            border-bottom:1px solid #d9dfd4;
            color:#354333;
          ">
            ${item.description || 'Artikel'}
            ${
              quantity > 1
                ? ` × ${quantity}`
                : ''
            }
          </td>

          <td style="
            padding:10px 0;
            border-bottom:1px solid #d9dfd4;
            text-align:right;
            color:#354333;
            white-space:nowrap;
          ">
            ${euro(item.amount_total)}
          </td>
        </tr>
      `;
    })
    .join('');

  const subtotal =
    euro(session?.amount_subtotal);

  const shipping =
    euro(session?.total_details?.amount_shipping);

  const total =
    euro(session?.amount_total);

  const orderNumber =
    session?.id || 'Nicht angegeben';

  const text = `
${greeting}

danke von Herzen für deine Bestellung und dein Vertrauen in meine Arbeit!

Dass eines meiner Stücke bald ein neues Zuhause bei dir findet, bedeutet mir unheimlich viel.

Du hast dich für ein echtes Unikat entschieden – ein Stück, das mit seinen kleinen, feinen Eigenheiten und sichtbaren Spuren der Handarbeit die Schönheit des Unvollkommenen feiert. Jedes meiner Werke entsteht in liebevoller, autodidaktischer Handarbeit und ganz ohne Eile.

Ich hoffe, es bringt genau diese Ruhe und Erdung in deinen Alltag, die ich beim Töpfern gefühlt habe.

Deine Bestellung im Überblick

Bestellnummer:
${orderNumber}

${productText}

Zwischensumme: ${subtotal}
Versand: ${shipping}
Gesamtbetrag: ${total}

Ich verpacke dein neues Lieblingsstück nun ganz behutsam, mit großer Sorgfalt und plastikfrei, damit es sicher bei dir ankommt.

Sobald dein Paket auf dem Weg zu dir ist, melde ich mich wieder bei dir.

Genieße deinen Tag und danke, dass du Teil meiner Reise bist.

Alles Liebe

Franca und André
von Dragemor Pottery
`.trim();

  const html = `
<!DOCTYPE html>
<html lang="de">
<body style="
  margin:0;
  padding:0;
  background:#eef2ea;
  font-family:Georgia,'Times New Roman',serif;
  color:#354333;
">

  <div style="
    max-width:650px;
    margin:0 auto;
    padding:35px 18px;
  ">

    <div style="
      background:#f8f6ef;
      border:1px solid #c99b5b;
      border-radius:20px;
      padding:38px 32px;
    ">

      <div style="
        text-align:center;
        margin-bottom:32px;
      ">

        <div style="
          color:#8a6937;
          font-size:14px;
          letter-spacing:2px;
          text-transform:uppercase;
          margin-bottom:10px;
        ">
          Dragemor Pottery
        </div>

        <h1 style="
          color:#354333;
          font-size:28px;
          font-weight:normal;
          line-height:1.3;
          margin:0;
        ">
          Ein Stück Entschleunigung
          ist auf dem Weg zu dir ✨
        </h1>

      </div>

      <p>${greeting}</p>

      <p style="line-height:1.7;">
        danke von Herzen für deine Bestellung und
        dein Vertrauen in meine Arbeit!
      </p>

      <p style="line-height:1.7;">
        Dass eines meiner Stücke bald ein neues
        Zuhause bei dir findet, bedeutet mir
        unheimlich viel.
      </p>

      <p style="line-height:1.7;">
        Du hast dich für ein echtes Unikat
        entschieden – ein Stück, das mit seinen
        kleinen, feinen Eigenheiten und sichtbaren
        Spuren der Handarbeit die Schönheit des
        Unvollkommenen feiert. Jedes meiner Werke
        entsteht in liebevoller, autodidaktischer
        Handarbeit und ganz ohne Eile.
      </p>

      <p style="line-height:1.7;">
        Ich hoffe, es bringt genau diese Ruhe und
        Erdung in deinen Alltag, die ich beim
        Töpfern gefühlt habe.
      </p>

      <div style="
        margin:30px 0;
        padding:24px;
        background:#e9eee5;
        border-radius:14px;
      ">

        <h2 style="
          margin:0 0 18px;
          color:#7d5d2e;
          font-size:20px;
          font-weight:normal;
        ">
          Deine Bestellung im Überblick
        </h2>

        <p style="
          font-size:13px;
          color:#657060;
          word-break:break-all;
        ">
          Bestellnummer:<br>
          ${orderNumber}
        </p>

        <table style="
          width:100%;
          border-collapse:collapse;
          margin-top:18px;
        ">
          ${productHtml}

          <tr>
            <td style="padding-top:15px;">
              Zwischensumme
            </td>

            <td style="
              padding-top:15px;
              text-align:right;
            ">
              ${subtotal}
            </td>
          </tr>

          <tr>
            <td style="padding-top:8px;">
              Versand
            </td>

            <td style="
              padding-top:8px;
              text-align:right;
            ">
              ${shipping}
            </td>
          </tr>

          <tr>
            <td style="
              padding-top:12px;
              font-weight:bold;
              color:#354333;
            ">
              Gesamtbetrag
            </td>

            <td style="
              padding-top:12px;
              text-align:right;
              font-weight:bold;
              color:#354333;
            ">
              ${total}
            </td>
          </tr>
        </table>

      </div>

      <p style="line-height:1.7;">
        Ich verpacke dein neues Lieblingsstück nun
        ganz behutsam, mit großer Sorgfalt und
        plastikfrei, damit es sicher bei dir ankommt.
      </p>

      <p style="line-height:1.7;">
        Sobald dein Paket auf dem Weg zu dir ist,
        melde ich mich wieder bei dir.
      </p>

      <p style="line-height:1.7;">
        Genieße deinen Tag und danke, dass du Teil
        meiner Reise bist.
      </p>

      <p style="
        margin-top:30px;
        line-height:1.7;
      ">
        Alles Liebe<br>
        <strong style="color:#7d5d2e;">
          Franca und André von Dragemor Pottery
        </strong>
      </p>

    </div>

  </div>

</body>
</html>
`.trim();

  await sendResendEmail({
    to: customerEmail,
    subject:
      'Ein Stück Entschleunigung ist auf dem Weg zu dir ✨',
    text,
    html,
  });
}

export default async function handler(req, res) {
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
      event.type ===
      'checkout.session.completed'
    ) {
      const session =
        event.data?.object;

      console.log(
        'Stripe Checkout abgeschlossen:',
        {
          sessionId: session?.id,
          paymentStatus:
            session?.payment_status,
          productIds:
            session?.metadata
              ?.dragemor_product_ids,
        }
      );

      if (
        session?.payment_status === 'paid'
      ) {
        const lineItems =
          await getStripeLineItems(
            session.id
          );
        
const productIds = (
  session?.metadata?.dragemor_product_ids || ''
)
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

await markProductsAsSold(productIds); 
        await sendInternalOrderEmail(
          session,
          lineItems
        );

        await sendCustomerOrderEmail(
          session,
          lineItems
        );
      }
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
