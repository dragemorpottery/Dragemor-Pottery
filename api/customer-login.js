import crypto from "crypto";

function hashPassword(password, salt) {
  return crypto
    .scryptSync(password, salt, 64)
    .toString("hex");
}

function hashSessionToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Methode nicht erlaubt."
    });
  }

  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();

  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({
      error: "Bitte gib deine E-Mail-Adresse und dein Passwort ein."
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

    const customers = await sql`
      SELECT
        id,
        name,
        email,
        password_hash,
        password_salt
      FROM customers
      WHERE email = ${email}
      LIMIT 1
    `;

    if (customers.length === 0) {
      return res.status(401).json({
        error: "E-Mail-Adresse oder Passwort ist nicht korrekt."
      });
    }

    const customer = customers[0];

    const enteredHash = hashPassword(
      password,
      customer.password_salt
    );

    const storedBuffer = Buffer.from(
      customer.password_hash,
      "hex"
    );

    const enteredBuffer = Buffer.from(
      enteredHash,
      "hex"
    );

    const passwordCorrect =
      storedBuffer.length === enteredBuffer.length &&
      crypto.timingSafeEqual(
        storedBuffer,
        enteredBuffer
      );

    if (!passwordCorrect) {
      return res.status(401).json({
        error: "E-Mail-Adresse oder Passwort ist nicht korrekt."
      });
    }

    await sql`
      CREATE TABLE IF NOT EXISTS customer_sessions (
        id BIGSERIAL PRIMARY KEY,
        customer_id BIGINT NOT NULL
          REFERENCES customers(id)
          ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `;

    // Abgelaufene Sitzungen aufräumen
    await sql`
      DELETE FROM customer_sessions
      WHERE expires_at < NOW()
    `;

    const sessionToken =
      crypto.randomBytes(32).toString("hex");

    const tokenHash =
      hashSessionToken(sessionToken);

    const expiresAt =
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await sql`
      INSERT INTO customer_sessions (
        customer_id,
        token_hash,
        expires_at
      )
      VALUES (
        ${customer.id},
        ${tokenHash},
        ${expiresAt.toISOString()}
      )
    `;

    res.setHeader(
      "Set-Cookie",
      [
        `dragemor_customer=${sessionToken}`,
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Max-Age=2592000"
      ].join("; ")
    );

    return res.status(200).json({
      success: true,
      message: "Du bist erfolgreich angemeldet.",
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email
      }
    });

  } catch (error) {
    console.error("Customer login error:", error);

    return res.status(500).json({
      error: "Die Anmeldung konnte nicht durchgeführt werden."
    });
  }
} 
