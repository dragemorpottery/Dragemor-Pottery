import crypto from "crypto";

function hashPassword(password, salt) {
  return crypto
    .scryptSync(password, salt, 64)
    .toString("hex");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendWelcomeEmail(name, email) {
  const resendApiKey = process.env.RESEND_API_KEY;

  if (!resendApiKey) {
    console.error("RESEND_API_KEY fehlt.");
    return;
  }

  const safeName = escapeHtml(name);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "Dragemor Pottery <kontakt@dragemor-pottery.de>",
      to: [email],
      subject: "Willkommen bei Dragemor Pottery ♡",
      html: `
        <div style="
          font-family: Georgia, 'Times New Roman', serif;
          color: #30372f;
          background: #f4f0e7;
          padding: 32px;
          line-height: 1.7;
        ">
          <div style="
            max-width: 600px;
            margin: 0 auto;
            background: #ffffff;
            padding: 36px;
            border-radius: 18px;
          ">
            <h1 style="
              font-size: 28px;
              font-weight: normal;
              margin-top: 0;
              color: #344436;
            ">
              Willkommen bei Dragemor Pottery ♡
            </h1>

            <p>Hallo ${safeName},</p>

            <p>
              wie schön, dass du da bist.
            </p>

            <p>
              Dein persönliches Kundenkonto bei
              <strong>Dragemor Pottery</strong> wurde erfolgreich erstellt.
            </p>

            <p>
              Du kannst dich ab jetzt mit deiner E-Mail-Adresse und deinem
              selbst gewählten Passwort anmelden.
            </p>

            <p style="margin-top: 30px;">
              Alles Liebe<br>
              Franca von Dragemor Pottery
            </p>
          </div>
        </div>
      `
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Resend Fehler ${response.status}: ${errorText}`
    );
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Methode nicht erlaubt."
    });
  }

  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();
  const password = String(req.body?.password || "");

  if (!name || !email || !password) {
    return res.status(400).json({
      error: "Bitte fülle alle Felder aus."
    });
  }

  if (!email.includes("@")) {
    return res.status(400).json({
      error: "Bitte gib eine gültige E-Mail-Adresse ein."
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      error: "Das Passwort muss mindestens 8 Zeichen lang sein."
    });
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return res.status(500).json({
      error: "Datenbank ist nicht eingerichtet."
    });
  }

  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl);

    await sql`
      CREATE TABLE IF NOT EXISTS customers (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    const existing = await sql`
      SELECT id
      FROM customers
      WHERE email = ${email}
      LIMIT 1
    `;

    if (existing.length > 0) {
      return res.status(409).json({
        error: "Für diese E-Mail-Adresse gibt es bereits ein Kundenkonto."
      });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);

    await sql`
      INSERT INTO customers (
        name,
        email,
        password_hash,
        password_salt
      )
      VALUES (
        ${name},
        ${email},
        ${passwordHash},
        ${salt}
      )
    `;

    // Bestätigungsmail versenden.
    // Falls die Mail fehlschlägt, bleibt das Kundenkonto trotzdem bestehen.
    try {
      await sendWelcomeEmail(name, email);
    } catch (mailError) {
      console.error(
        "Customer welcome email error:",
        mailError
      );
    }

    return res.status(201).json({
      success: true,
      message: "Dein Kundenkonto wurde erfolgreich erstellt."
    });

  } catch (error) {
    console.error("Customer registration error:", error);

    if (error?.code === "23505") {
      return res.status(409).json({
        error: "Für diese E-Mail-Adresse gibt es bereits ein Kundenkonto."
      });
    }

    return res.status(500).json({
      error: "Das Kundenkonto konnte nicht erstellt werden."
    });
  }
} 


