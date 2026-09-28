import crypto from "crypto";

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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Methode nicht erlaubt."
    });
  }

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

  } catch (error) {
    console.error(
      "Customer check error:",
      error
    );

    return res.status(500).json({
      error:
        "Der Anmeldestatus konnte nicht geprüft werden."
    });
  }
} 
