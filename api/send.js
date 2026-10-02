const FROM = "Dragemor Pottery <kontakt@dragemor-pottery.de>";
const OWNER_EMAIL = "afspring23@gmail.com";

function clean(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function sendEmail(payload) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || "E-Mail konnte nicht gesendet werden.");
    error.details = data;
    throw error;
  }

  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Methode nicht erlaubt" });
  }

  try {
    const body = req.body || {};
    const type = clean(body.type, 40);

    // ========================================
    // ELEKTRONISCHER WIDERRUF
    // ========================================
    if (type === "withdrawal") {
      const name = clean(body.name, 160);
      const email = clean(body.email, 254);
      const contract = clean(body.contract, 500);
      const orderDate = clean(body.orderDate, 30);
      const message = clean(body.message, 3000);

      if (!name || !email || !contract) {
        return res.status(400).json({
          error: "Bitte alle Pflichtfelder ausfüllen."
        });
      }

      if (!validEmail(email)) {
        return res.status(400).json({
          error: "Bitte gib eine gültige E-Mail-Adresse ein."
        });
      }

      const receivedAt = new Date();
      const receivedAtIso = receivedAt.toISOString();
      const receivedAtDe = new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        dateStyle: "medium",
        timeStyle: "medium"
      }).format(receivedAt);

      // 1) Benachrichtigung an Dragemor Pottery / Gmail
      await sendEmail({
        from: FROM,
        to: [OWNER_EMAIL],
        reply_to: email,
        subject: `Widerruf – ${contract}`,
        text:
          `Neuer Widerruf über dragemor-pottery.de\n\n` +
          `Eingang: ${receivedAtDe}\n` +
          `Name: ${name}\n` +
          `E-Mail: ${email}\n` +
          `Bestellung / Artikel: ${contract}\n` +
          `Bestelldatum: ${orderDate || "nicht angegeben"}\n\n` +
          `Zusätzliche Nachricht:\n${message || "-"}`
      });

      // 2) Automatische Eingangsbestätigung an den Kunden
      let confirmationSent = true;

      try {
        await sendEmail({
          from: FROM,
          to: [email],
          reply_to: "kontakt@dragemor-pottery.de",
          subject: "Eingangsbestätigung deines Widerrufs – Dragemor Pottery",
          text:
            `Hallo ${name},\n\n` +
            `hiermit bestätigen wir den Eingang deines Widerrufs bei Dragemor Pottery.\n\n` +
            `Eingang: ${receivedAtDe}\n` +
            `Bestellung / Artikel: ${contract}\n` +
            `Bestelldatum: ${orderDate || "nicht angegeben"}\n` +
            `Zusätzliche Nachricht: ${message || "-"}\n\n` +
            `Bitte bewahre diese E-Mail als Eingangsbestätigung auf.\n\n` +
            `Alles Liebe\n` +
            `Franca von Dragemor Pottery\n` +
            `kontakt@dragemor-pottery.de`
        });
      } catch (confirmationError) {
        confirmationSent = false;
        console.error("Widerruf-Bestätigung konnte nicht gesendet werden:", confirmationError.details || confirmationError);
      }

      return res.status(200).json({
        success: true,
        receivedAt: receivedAtIso,
        confirmationSent
      });
    }

    // ========================================
    // NORMALES KONTAKTFORMULAR
    // ========================================
    const name = clean(body.name, 160);
    const email = clean(body.email, 254);
    const betreff = clean(body.betreff, 200);
    const nachricht = clean(body.nachricht, 5000);

    if (!name || !email || !nachricht) {
      return res.status(400).json({
        error: "Bitte alle Pflichtfelder ausfüllen."
      });
    }

    if (!validEmail(email)) {
      return res.status(400).json({
        error: "Bitte gib eine gültige E-Mail-Adresse ein."
      });
    }

    await sendEmail({
      from: FROM,
      to: [OWNER_EMAIL],
      reply_to: email,
      subject: betreff || "Neue Nachricht über Dragemor Pottery",
      text:
        `Neue Nachricht über die Website\n\n` +
        `Name: ${name}\n` +
        `E-Mail: ${email}\n` +
        `Betreff: ${betreff || "-"}\n\n` +
        `Nachricht:\n${nachricht}`
    });

    return res.status(200).json({
      success: true,
      message: "Nachricht erfolgreich gesendet."
    });

  } catch (error) {
    console.error("Serverfehler:", error.details || error);

    return res.status(500).json({
      error: "Serverfehler beim Senden der Nachricht."
    });
  }
}
