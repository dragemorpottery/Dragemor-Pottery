export default async function handler(req, res) {
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
      SELECT
        product_id,
        status,
        name,
        category,
        price,
        measure,
        description,
        images
      FROM products
      WHERE name IS NOT NULL
      ORDER BY updated_at DESC
    `;

    return res.status(200).json({
      products
    });

  } catch (error) {
    console.error("Produkte Fehler:", error);

    return res.status(500).json({
      error: "Produkte konnten nicht geladen werden."
    });
  }
} 
