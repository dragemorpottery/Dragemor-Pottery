// Public image endpoint for a single shop preview photo.
// The version query parameter ('v') is used only to invalidate browser caches.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  }
  const id = req.query?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    return res.status(400).json({ error: 'Ungültige Produkt-ID.' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'Datenbank ist nicht eingerichtet.' });
  }
  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    // Read only photo #1, rather than transferring every photo of the product.
    const rows = await sql`
      SELECT to_jsonb(images)->>0 AS preview_image
      FROM products WHERE product_id = ${id}
    `;
    const value = rows[0]?.preview_image;
    if (typeof value !== 'string' || !value) {
      return res.status(404).json({ error: 'Produktbild nicht gefunden.' });
    }

    // Existing external files in the site's bilder/ folder remain supported.
    if (/^\/?bilder\/[a-zA-Z0-9_.\/-]+$/.test(value) && !value.includes('..')) {
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
      return res.redirect(302, '/' + value.replace(/^\//, ''));
    }

    const match = /^data:(image\/(?:jpeg|png|webp|gif|avif));base64,([a-zA-Z0-9+/=\r\n]+)$/i.exec(value);
    if (!match) {
      return res.status(415).json({ error: 'Bildformat nicht unterstützt.' });
    }
    const content = Buffer.from(match[2], 'base64');
    res.setHeader('Content-Type', match[1].toLowerCase());
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // A change to updated_at gives the image a new v= URL in the catalog.
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).send(content);
  } catch (error) {
    console.error('Produktbild Fehler:', error);
    return res.status(500).json({ error: 'Produktbild konnte nicht geladen werden.' });
  }
}
