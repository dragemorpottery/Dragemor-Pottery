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
if (req.method === "POST" && req.body?.action === "setup-keramik-details") {
  const keramikDetails = [
    {
      product_id: "keramik-1",
      name: "WaterDragon",
      category: "Momente des Innehaltens",
      price: 1800,
      measure: "ca. 400 ml"
      description: "Spiral-Effect innen und außen in Türkis-Grün, mit weißlich schimmerndem Rand."
    },
    {
      product_id: "keramik-4",
      name: "WaterDragon",
      category: "Momente des Innehaltens",
      price: 1800,
      measure: "ca. 500 ml"
      description: "Spiral-Effect innen und außen in Türkis-Grün, mit weißlich schimmerndem Rand."
    },
    {
      product_id: "keramik-7",
      name: "WaterDragon",
      category: "Momente des Innehaltens",
      price: 1800,
      measure: "ca. 350 ml"
      description: "Spiral-Effect innen und außen in Türkis-Grün, mit weißlich schimmerndem Rand."
    }
,
    {
      product_id: "keramik-9",
      name: "Erdtanz",
      category: "Momente des Innehaltens",
      price: 1500,
      measure: "ca. 200 ml"
      description: "schwarze Steinzeugkeramik mit filigranen Details außen und brauner innenseite."
    }
,
    {
      product_id: "keramik-12",
      name: "Waldritual – Keramikset",
      category: "Gemeinsame Zeit",
      price: 3500,
      measure: "Krug ca. 500 ml / Becher ca. 200 ml / Kännchen ca. 50 ml"
      description: "Tiefes Blau mit weinroten/lila Akzenten. Mit filigranen Details am Henkel."
    }
,
    {
      product_id: "keramik-14",
      name: "WaterDragon",
      category: "Momente des Innehaltens",
      price: 1500,
      measure: "ca. 200 ml"
      description: "Spiral-Effect innen und außen in Türkis-Grün, mit weißlich schimmerndem Rand."
    }
,
    {
      product_id: "keramik-24",
      name: "Erdtanz",
      category: "Momente des Innehaltens",
      price: 1500,
      measure: "ca. 200 ml"
      description: "schwarze Steinzeugkeramik mit filigranen Details außen und brauner innenseite."
    }
,
    {
      product_id: "keramik-30",
      name: "des Drachens Wasser",
      category: "Momente des Innehaltens",
      price: 1900,
      measure: "ca. 400 ml"
      descrition: "Helle Türkies-Wellen wie am weißen Strand, mit filigrane Details."
    }
,
    {
      product_id: "keramik-37",
      name: "Waldgeflüster – Set",
      category: "Momente des Innehaltens",
      price: 1500,
      measure: "ca. 250 ml + 150 ml"
      description: "Edles Silbrig-glänzender Effekt in anthrazit außen. Innen tiefes klarglänzendes Zartbitter-braun."
    }
,
    {
      product_id: "keramik-40",
      name: "Dämmerwald",
      category: "Momente des Innehaltens",
      price: 1000,
      measure: "ca. 200 ml"
      descrition: "Strand-sandige Optik mit karamellisierten Verläufen auf weißem Steinzeug.
    }
,
    {
      product_id: "keramik-49",
      name: "Meeresgrund",
      category: "Gemeinsame Zeit",
      price: 1800,
      measure: "Ø ca. 19 cm"
      descrition: "Schimmerndes Blau und Beige auf schwarzem Ton, mit filigranen Details in der mitte."
    }
,
    {
      product_id: "keramik-56",
      name: "des Drachens Wasser",
      category: "Gemeinsame Zeit",
      price: 1800,
      measure: "Ø ca. 19 cm"
      descrition: "Helle Türkies-Wellen wie am weißen Strand, mit filigrane Details."
    }
,
    {
      product_id: "keramik-58",
      name: "des Drachens Wasser",
      category: "Gemeinsame Zeit",
      price: 1500,
      measure: "Ø ca. 17 cm"
      descrition: "Helle Türkies-Wellen wie am weißen Strand, mit filigrane Details."
    }
  ];

  for (const product of keramikDetails) {
    await sql`
      UPDATE products
      SET
        name = ${product.name},
        category = ${product.category},
        price = ${product.price},
        measure = ${product.measure},
        updated_at = NOW()
      WHERE product_id = ${product.product_id}
    `;
  }

  return res.status(200).json({
    ok: true,
    message: "Keramikdetails wurden übernommen."
  });
}
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
if (req.method === "POST" && req.body?.action === "delete-product") {
  const { product_id } = req.body;

  if (!product_id) {
    return res.status(400).json({
      error: "Produkt-ID fehlt."
    });
  }

  const deleted = await sql`
    DELETE FROM products
    WHERE product_id = ${product_id}
    RETURNING product_id
  `;

  if (deleted.length === 0) {
    return res.status(404).json({
      error: "Produkt wurde nicht gefunden."
    });
  }

  return res.status(200).json({
    ok: true,
    product_id: deleted[0].product_id
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
