export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Methode nicht erlaubt." });
  }
  res.setHeader("Cache-Control", "private, no-store, no-cache, max-age=0");

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: "Datenbank ist nicht eingerichtet." });
  }
  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(process.env.DATABASE_URL);
    // Even unfilled legacy rows count as present: the website can retain
    // its old photo/name until the user fills the record in the admin UI.
    const products = await sql`
      SELECT product_id, status, name, category, price, measure, description, images
      FROM products ORDER BY updated_at DESC
    `;
    // Read-only check allows this endpoint to work before the first deletion.
    const exists = await sql`SELECT to_regclass('public.deleted_products') AS relation`;
    const deletedIds = exists[0]?.relation
      ? (await sql`SELECT product_id FROM deleted_products`).map(row => row.product_id)
      : [];
    return res.status(200).json({ products, deletedIds });
  } catch (error) {
    console.error("Produkte Fehler:", error);
    return res.status(500).json({ error: "Produkte konnten nicht geladen werden." });
  }
}
