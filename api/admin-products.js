import crypto from "crypto";

function createToken() {
  return crypto
    .createHmac("sha256", process.env.ADMIN_PASSWORD)
    .update("dragemor-admin")
    .digest("hex");
}

function isAdmin(req) {
  if (!process.env.ADMIN_PASSWORD) return false;

  const cookies = req.headers.cookie || "";

  const adminCookie = cookies
    .split(";")
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith("dragemor_admin="));

  if (!adminCookie) return false;

  const token = adminCookie.substring(
    "dragemor_admin=".length
  );

  return token === createToken();
}

export default async function handler(req, res) {
  if (!isAdmin(req)) {
    return res.status(401).json({
      error: "Nicht angemeldet."
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

    if (req.method === "GET") {
      const products = await sql`
        SELECT product_id, status, updated_at
        FROM products
        ORDER BY product_id
      `;

      return res.status(200).json({
        products
      });
    }

    if (req.method === "POST") {
      const { product_id, status } = req.body || {};

      if (!product_id) {
        return res.status(400).json({
          error: "Produkt-ID fehlt."
        });
      }

      if (!["available", "sold"].includes(status)) {
        return res.status(400).json({
          error: "Ungültiger Status."
        });
      }

      const updated = await sql`
        UPDATE products
        SET
          status = ${status},
          updated_at = NOW()
        WHERE product_id = ${product_id}
        RETURNING product_id, status, updated_at
      `;

      if (updated.length === 0) {
        return res.status(404).json({
          error: "Produkt wurde nicht gefunden."
        });
      }

      return res.status(200).json({
        ok: true,
        product: updated[0]
      });
    }

    return res.status(405).json({
      error: "Methode nicht erlaubt."
    });

  } catch (error) {
    console.error(
      "Admin-Produkte Fehler:",
      error
    );

    return res.status(500).json({
      error: "Produkte konnten nicht verarbeitet werden."
    });
  }
} 
