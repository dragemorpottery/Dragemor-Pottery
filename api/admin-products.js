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
if (req.method === "POST" && req.body?.action === "setup-products") {
  const productIds = [
    "keramik-24",
    "keramik-26",
    "keramik-30",
    "keramik-33",
    "keramik-37",
    "keramik-40",
    "keramik-49",
    "keramik-53",
    "keramik-56",
    "keramik-58",
    "leder-1",
  "leder-2",
  "leder-3",
  "leder-4",
  "leder-5",
  "leder-6",
  "leder-7",
  "leder-8",
  "leder-9",
  "leder-10",
  "leder-11",
  "leder-12" 
  ];

  for (const productId of productIds) {
    await sql`
      INSERT INTO products (product_id, status)
      VALUES (${productId}, 'available')
      ON CONFLICT (product_id) DO NOTHING
    `;
  }

  return res.status(200).json({
    ok: true,
    message: "Fehlende Keramikprodukte wurden angelegt."
  });
} 

    if (req.method === "GET") {
      const products = await sql`
        SELECT product_id, status, updated_at, name, category, price, measure, description, images 
        FROM products
        ORDER BY product_id
      `;

      return res.status(200).json({
        products
      });
    }
if (req.method === "POST" && req.body?.action === "create-product") {
  const {
    product_id,
    name,
    category,
    price,
    measure,
    description,
    images
  } = req.body;

  if (!product_id || !name || !category || price === undefined) {
    return res.status(400).json({
      error: "Bitte alle Pflichtfelder ausfüllen."
    });
  }

  const created = await sql`
    INSERT INTO products (
      product_id,
      status,
      name,
      category,
      price,
      measure,
      description,
      images
    )
    VALUES (
      ${product_id},
      'available',
      ${name},
      ${category},
      ${price},
      ${measure || null},
      ${description || null},
      ${images || []}
    )
    RETURNING *
  `;

  return res.status(201).json({
    ok: true,
    product: created[0]
  });
} 
    if (req.method === "POST" && req.body?.action === "update-product") {
  const {
    product_id,
    name,
    category,
    price,
    measure,
    description,
    images
  } = req.body;

  if (!product_id || !name || !category || price === undefined) {
    return res.status(400).json({
      error: "Bitte alle Pflichtfelder ausfüllen."
    });
  }

  const updated = images
    ? await sql`
        UPDATE products
        SET
          name = ${name},
          category = ${category},
          price = ${price},
          measure = ${measure || null},
          description = ${description || null},
          images = ${images},
          updated_at = NOW()
        WHERE product_id = ${product_id}
        RETURNING *
      `
    : await sql`
        UPDATE products
        SET
          name = ${name},
          category = ${category},
          price = ${price},
          measure = ${measure || null},
          description = ${description || null},
          updated_at = NOW()
        WHERE product_id = ${product_id}
        RETURNING *
      `;

  return res.status(200).json({
    ok: true,
    product: updated[0]
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
