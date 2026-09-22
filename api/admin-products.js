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

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Methode nicht erlaubt."
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

    const products = await sql`
      SELECT product_id, status, updated_at
      FROM products
      ORDER BY product_id
    `;

    return res.status(200).json({
      products
    });

  } catch (error) {
    console.error(
      "Admin-Produkte konnten nicht geladen werden:",
      error
    );

    return res.status(500).json({
      error: "Produkte konnten nicht geladen werden."
    });
  }
} 
