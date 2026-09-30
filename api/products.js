// Small shop overview: only the first image travels with the catalog.
// Full product galleries are retrieved only when an item is opened.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Methode nicht erlaubt." });
  }
  res.setHeader("Cache-Control", "private, no-store, no-cache, max-age=0");

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: "Datenbank ist nicht eingerichtet." });
  }
  const id = req.query?.id;
  if (id != null && (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id))) {
    return res.status(400).json({ error: "Ungültige Produkt-ID." });
  }

  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(process.env.DATABASE_URL);
    if (id) {
      const [rows, table] = await Promise.all([
        sql`SELECT product_id, images, updated_at FROM products WHERE product_id = ${id}`,
        sql`SELECT to_regclass('public.deleted_products') AS relation`
      ]);
      if (!rows.length) return res.status(404).json({ error: "Produkt nicht gefunden." });
      if (table[0]?.relation) {
        const tombstones = await sql`SELECT product_id FROM deleted_products WHERE product_id = ${id}`;
        if (tombstones.length) return res.status(404).json({ error: "Produkt nicht gefunden." });
      }
      const product = rows[0];
      return res.status(200).json({
        product_id: product.product_id,
        images: Array.isArray(product.images) ? product.images : [],
        updated_at: product.updated_at
      });
    }

    // to_jsonb accepts both Postgres text[] and jsonb arrays. This prevents
    // PostgreSQL from transferring every full-size photo for the shop list.
    const [rows, table] = await Promise.all([
      sql`SELECT product_id, status, name, category, price, measure, description,
                 updated_at,
                 to_jsonb(images)->0 AS preview_image,
                 CASE WHEN jsonb_typeof(to_jsonb(images)) = 'array'
                      THEN jsonb_array_length(to_jsonb(images)) ELSE 0 END AS image_count
          FROM products ORDER BY updated_at DESC`,
      sql`SELECT to_regclass('public.deleted_products') AS relation`
    ]);
    const products = rows.map(({ preview_image, image_count, ...rest }) => ({
      ...rest,
      images: typeof preview_image === "string" && preview_image ? [preview_image] : [],
      imageCount: image_count
    }));
    const deletedIds = table[0]?.relation
      ? (await sql`SELECT product_id FROM deleted_products`).map(row => row.product_id)
      : [];
    return res.status(200).json({ products, deletedIds });
  } catch (error) {
    console.error("Produkte Fehler:", error);
    return res.status(500).json({ error: "Produkte konnten nicht geladen werden." });
  }
}
