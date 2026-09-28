import crypto from "crypto";

function hashPassword(password, salt) {
  return crypto
    .scryptSync(password, salt, 64)
    .toString("hex");
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

    // Tabelle beim ersten Aufruf automatisch anlegen.
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

    return res.status(201).json({
      success: true,
      message: "Dein Kundenkonto wurde erfolgreich erstellt."
    });

  } catch (error) {
    console.error("Customer registration error:", error);

    // Falls zwei Registrierungen mit derselben Mail
    // praktisch gleichzeitig eintreffen.
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
