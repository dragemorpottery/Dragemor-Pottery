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

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "")
    .split(";")
    .map(cookie => cookie.trim());

  const wanted = cookies.find(cookie =>
    cookie.startsWith(`${name}=`)
  );

  if (!wanted) return null;

  return wanted.substring(name.length + 1);
}

function clearCustomerCookie(res) {
  res.setHeader(
    "Set-Cookie",
    [
      "dragemor_customer=",
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Max-Age=0"
    ].join("; ")
  );
}

export default async function handler(req, res) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return res.status(500).json({
      error: "Datenbank ist nicht eingerichtet."
    });
  }

  try {
    const { neon } = await import(
      "@neondatabase/serverless"
    );

    const sql = neon(databaseUrl);

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

    await sql`
      DELETE FROM customer_sessions
      WHERE expires_at < NOW()
    `;

    // -------------------------
    // LOGINSTATUS PRÜFEN
    // -------------------------
    if (req.method === "GET") {
      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
      );

      const sessionToken =
        getCookie(req, "dragemor_customer");

      if (!sessionToken) {
        return res.status(200).json({
          loggedIn: false
        });
      }

      const tokenHash =
        hashSessionToken(sessionToken);

      const sessions = await sql`
        SELECT
          c.id,
          c.name,
          c.email
        FROM customer_sessions s
        JOIN customers c
          ON c.id = s.customer_id
        WHERE s.token_hash = ${tokenHash}
          AND s.expires_at > NOW()
        LIMIT 1
      `;

      if (sessions.length === 0) {
        clearCustomerCookie(res);

        return res.status(200).json({
          loggedIn: false
        });
      }

      const customer = sessions[0];

      return res.status(200).json({
        loggedIn: true,
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email
        }
      });
    }

    // -------------------------
    // ABMELDEN
    // -------------------------
    if (req.method === "DELETE") {
      const sessionToken =
        getCookie(req, "dragemor_customer");

      if (sessionToken) {
        const tokenHash =
          hashSessionToken(sessionToken);

        await sql`
          DELETE FROM customer_sessions
          WHERE token_hash = ${tokenHash}
        `;
      }

      clearCustomerCookie(res);

      return res.status(200).json({
        success: true,
        message: "Du wurdest erfolgreich abgemeldet."
      });
    }

    // -------------------------
    // ANMELDEN
    // -------------------------
    if (req.method === "POST") {
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();

      const password =
        String(req.body?.password || "");

      if (!email || !password) {
        return res.status(400).json({
          error:
            "Bitte gib deine E-Mail-Adresse und dein Passwort ein."
        });
      }

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
          error:
            "E-Mail-Adresse oder Passwort ist nicht korrekt."
        });
      }

      const customer = customers[0];

      const enteredHash =
        hashPassword(
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
          error:
            "E-Mail-Adresse oder Passwort ist nicht korrekt."
        });
      }

      const sessionToken =
        crypto.randomBytes(32).toString("hex");

      const tokenHash =
        hashSessionToken(sessionToken);

      const expiresAt =
        new Date(
          Date.now() +
          30 * 24 * 60 * 60 * 1000
        );

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
    }

    return res.status(405).json({
      error: "Methode nicht erlaubt."
    });

  } catch (error) {
    console.error(
      "Customer account error:",
      error
    );

    return res.status(500).json({
      error:
        "Die Kundenkonto-Funktion konnte nicht ausgeführt werden."
    });
  }
} 
