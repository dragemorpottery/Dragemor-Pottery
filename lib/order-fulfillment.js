// Shared invoice and email flow for Stripe and direct PayPal payments.
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
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

async function getNextInvoiceNumber(sql) {
  const year = new Date().getFullYear();

  const result = await sql`
    INSERT INTO invoice_counters (
      year,
      last_number
    )
    VALUES (
      ${year},
      1
    )
    ON CONFLICT (year)
    DO UPDATE SET
      last_number =
        invoice_counters.last_number + 1
    RETURNING last_number
  `;

  const number = result[0].last_number;

  return `DP-${year}-${String(number).padStart(4, '0')}`;
} 
export function orderNumberFromInvoice(invoiceNumber) {
  return invoiceNumber.replace(/^DP-(\d{4})-0*(\d+)$/, (_, year, number) =>
    `${year}-${number.padStart(3, '0')}`);
}

export async function createInvoice(session, lineItems, existingSql) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl && !existingSql) {
    throw new Error(
      'DATABASE_URL ist nicht eingerichtet.'
    );
  }

  const { neon } =
    await import('@neondatabase/serverless');

  const sql = existingSql || neon(databaseUrl);

  const existing = await sql`
    SELECT invoice_number
    FROM invoices
    WHERE stripe_session_id = ${session.id}
    LIMIT 1
  `;

  if (existing.length > 0) {
    return existing[0].invoice_number;
  }

  const invoiceNumber =
    await getNextInvoiceNumber(sql);

  const customer =
    session?.customer_details || {};

  const address =
    customer?.address || {};

  const customerAddress = [
    address?.line1,
    address?.line2,
    [address?.postal_code, address?.city]
      .filter(Boolean)
      .join(' '),
    address?.country,
  ]
    .filter(Boolean)
    .join('\n');

  const items = lineItems.map(item => ({
    description:
      item.description || 'Artikel',
    quantity: item.quantity || 1,
    amount_total:
      item.amount_subtotal ?? item.amount_total ?? 0,
  }));

  await sql`
    INSERT INTO invoices (
      invoice_number,
      stripe_session_id,
      customer_name,
      customer_email,
      customer_address,
      items,
      subtotal,
      shipping,
      total
    )
    VALUES (
      ${invoiceNumber},
      ${session.id},
      ${customer?.name || ''},
      ${customer?.email || session?.customer_email || ''},
      ${customerAddress},
      ${JSON.stringify(items)},
      ${session?.amount_subtotal || 0},
      ${session?.total_details?.amount_shipping || 0},
      ${session?.amount_total || 0}
    )
  `;

  return invoiceNumber;
} 

export async function createInvoicePdf(
  session,
  lineItems,
  invoiceNumber
) {
  const { PDFDocument, StandardFonts, rgb } =
    await import('pdf-lib');

  const pdfDoc = await PDFDocument.create();

  const page = pdfDoc.addPage([595.28, 841.89]);

  const font =
    await pdfDoc.embedFont(
      StandardFonts.Helvetica
    );

  const boldFont =
    await pdfDoc.embedFont(
      StandardFonts.HelveticaBold
    );

  const { width, height } = page.getSize();
  const invoiceDate =
    new Date(session.invoice_date || Date.now()).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'Europe/Berlin',
    });

  page.drawText('DRAGEMOR-POTTERY', {
    x: 50,
    y: height - 60,
    size: 16,
    font: boldFont,
  });

  page.drawText('Franca Bennin', {
    x: 50,
    y: height - 80,
    size: 10,
    font,
  });

  page.drawText('Damm 1', {
    x: 50,
    y: height - 95,
    size: 10,
    font,
  });

  page.drawText('24803 Tielen', {
    x: 50,
    y: height - 110,
    size: 10,
    font,
  });

  page.drawText(`Rechnung ${invoiceNumber}`, {
    x: 50,
    y: height - 165,
    size: 20,
    font: boldFont,
  });

  page.drawText(`Rechnungsdatum: ${invoiceDate}`, {
    x: 50,
    y: height - 190,
    size: 10,
    font,
  }); 

  const customer =
    session?.customer_details || {};

  const address =
    customer?.address || {};

  let customerY = height - 235;

  page.drawText('Rechnung an:', {
    x: 50,
    y: customerY,
    size: 10,
    font: boldFont,
  });

  customerY -= 18;

  const customerAddressLines = [
    customer?.name,
    address?.line1,
    address?.line2,
    [address?.postal_code, address?.city]
      .filter(Boolean)
      .join(' '),
    address?.country,
  ].filter(Boolean);

  for (const line of customerAddressLines) {
    page.drawText(String(line), {
      x: 50,
      y: customerY,
      size: 10,
      font,
    });

    customerY -= 15;
  } 
 let itemsY = customerY - 25;

  page.drawText('Artikel', {
    x: 50,
    y: itemsY,
    size: 10,
    font: boldFont,
  });

  page.drawText('Betrag', {
    x: 470,
    y: itemsY,
    size: 10,
    font: boldFont,
  });

  itemsY -= 20;

  for (const item of lineItems) {
    const quantity = item.quantity || 1;

    const description =
      `${item.description || 'Artikel'}${
        quantity > 1 ? ` x ${quantity}` : ''
      }`;

    page.drawText(description, {
      x: 50,
      y: itemsY,
      size: 10,
      font,
    });

    page.drawText(euro(item.amount_subtotal ?? item.amount_total), {
      x: 470,
      y: itemsY,
      size: 10,
      font,
    });

    itemsY -= 20;
  }

  itemsY -= 15;

  page.drawText('Zwischensumme:', {
    x: 350,
    y: itemsY,
    size: 10,
    font,
  });

  page.drawText(euro(session?.amount_subtotal), {
    x: 470,
    y: itemsY,
    size: 10,
    font,
  });

  itemsY -= 18;

  page.drawText('Versand:', {
    x: 350,
    y: itemsY,
    size: 10,
    font,
  });

  page.drawText(
    euro(session?.total_details?.amount_shipping),
    {
      x: 470,
      y: itemsY,
      size: 10,
      font,
    }
  );

  const voucherDiscount = Number(session?.total_details?.amount_discount || 0);
  if (voucherDiscount > 0) {
    itemsY -= 18;

    page.drawText('Gutschein:', {
      x: 350,
      y: itemsY,
      size: 10,
      font,
    });

    page.drawText(`-${euro(voucherDiscount)}`, {
      x: 470,
      y: itemsY,
      size: 10,
      font,
    });
  }

  itemsY -= 22;

  page.drawText('Gesamtbetrag:', {
    x: 350,
    y: itemsY,
    size: 11,
    font: boldFont,
  });

  page.drawText(euro(session?.amount_total), {
    x: 470,
    y: itemsY,
    size: 11,
    font: boldFont,
  }); 
  itemsY -= 18;

page.drawText("Umsatzsteuer:", {
  x: 350,
  y: itemsY,
  size: 10,
  font: font,
});

page.drawText("0,00 EUR", {
  x: 470,
  y: itemsY,
  size: 10,
  font: font,
}); 

 itemsY -= 45;

  const taxNumber =
    process.env.INVOICE_TAX_NUMBER || '';

  if (taxNumber) {
    page.drawText(`Steuernummer: ${taxNumber}`, {
      x: 50,
      y: itemsY,
      size: 9,
      font,
    });

    itemsY -= 18;
  }

  page.drawText(
    'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    {
      x: 50,
      y: itemsY,
      size: 9,
      font,
    }
  ); 
const pdfBytes = await pdfDoc.save();

  return Buffer.from(pdfBytes); 
} 

async function sendResendEmail({
  to,
  subject,
  text,
  html,
  attachments,
  idempotencyKey,
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
if (attachments?.length) {
  body.attachments = attachments;
} 
  const response = await fetch(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization:
          `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
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

export async function sendInternalOrderEmail(
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
        item.amount_subtotal ?? item.amount_total
      )}`;
    })
    .join('\n');

  const total = euro(session?.amount_total);
  const voucherDiscount = Number(session?.total_details?.amount_discount || 0);
  const voucherLine = voucherDiscount > 0
    ? `\nGutschein:\n-${euro(voucherDiscount)}\n`
    : '';

  const emailText = `
Neue bezahlte Bestellung bei Dragemor Pottery

Bestellnummer:
${session?.order_number || session?.id || 'Nicht angegeben'}

Produkte:
${products || 'Nicht angegeben'}

Zwischensumme:
${euro(session?.amount_subtotal)}

Versand:
${euro(session?.total_details?.amount_shipping)}
${voucherLine}
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
    idempotencyKey: session.email_keys?.internal,
    to: [
  'kontakt@dragemor-pottery.de',
  process.env.ORDER_NOTIFICATION_EMAIL
].filter(Boolean), 
    subject:
      `Neue Bestellung – Dragemor Pottery – ${total}`,
    text: emailText,
  });
}

export async function sendCustomerOrderEmail(
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
        item.amount_subtotal ?? item.amount_total
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
            ${escapeHtml(item.description || 'Artikel')}
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
            ${euro(item.amount_subtotal ?? item.amount_total)}
          </td>
        </tr>
      `;
    })
    .join('');

  const subtotal =
    euro(session?.amount_subtotal);

  const shipping =
    euro(session?.total_details?.amount_shipping);

  const voucherDiscountAmount = Number(session?.total_details?.amount_discount || 0);
  const voucherDiscount = euro(voucherDiscountAmount);
  const voucherTextLine = voucherDiscountAmount > 0
    ? `\nGutschein: -${voucherDiscount}`
    : '';
  const voucherHtmlRow = voucherDiscountAmount > 0
    ? `<tr><td style="padding-top:8px;">Gutschein</td><td style="padding-top:8px;text-align:right;">-${voucherDiscount}</td></tr>`
    : '';

  const total =
    euro(session?.amount_total);

  const orderNumber =
    session?.order_number || session?.id || 'Nicht angegeben';

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
Versand: ${shipping}${voucherTextLine}
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

      <p>${escapeHtml(greeting)}</p>

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

          ${voucherHtmlRow}

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
    idempotencyKey: session.email_keys?.customer,
    to: customerEmail,
    subject:
      'Ein Stück Entschleunigung ist auf dem Weg zu dir ✨',
    text,
    html,
  });
}

export async function sendInvoiceEmail(
  session,
  lineItems,
  invoiceNumber
) {
  const customer =
    session?.customer_details || {};

  const customerEmail =
    customer?.email || session?.customer_email;

  if (!customerEmail) {
    console.error(
      'Keine Kunden-E-Mail für Rechnung vorhanden.'
    );
    return;
  }

  const pdfBuffer = session.invoice_pdf_base64
    ? Buffer.from(session.invoice_pdf_base64, 'base64')
    : await createInvoicePdf(session, lineItems, invoiceNumber);

  const firstName =
    customer?.name
      ?.trim()
      ?.split(/\s+/)[0] || '';

  const greeting =
    firstName
      ? `Hallo ${firstName},`
      : 'Hallo,';

  const text = `
${greeting}

anbei findest du die Rechnung zu deiner Bestellung bei Dragemor Pottery.

Rechnungsnummer: ${invoiceNumber}
Gesamtbetrag: ${euro(session?.amount_total)}

Vielen Dank für deine Bestellung und dein Vertrauen in meine Arbeit.

Alles Liebe

Franca und André
von Dragemor Pottery
`.trim();

  await sendResendEmail({
    idempotencyKey: session.email_keys?.invoice,
    to: customerEmail,
    subject: `Deine Rechnung ${invoiceNumber} – Dragemor Pottery`,
    text,
    attachments: [
      {
        filename: `Rechnung-${invoiceNumber}.pdf`,
        content: pdfBuffer.toString('base64'),
      },
    ],
  });
} 

