import { serveProductPage, serveProductSitemap } from '../lib/seo.js';

// Dragemor Pottery: schneller Produktkatalog mit Bildern über dieselbe API.
// Funktioniert mit Vercel Hobby: keine zusätzliche api/product-image.js nötig.
// Aufrufe:
//   /api/products                 -> Produktliste mit schlanken Bild-URLs
//   /api/products?id=PRODUKT-ID   -> komplette Produktgalerie
//   /api/products?image=1&id=PRODUKT-ID -> erstes Bild als Bildantwort
export default async function handler(req, res) {
  // SEO-Seiten über dieselbe bestehende API ausliefern; unverändertes Katalogverhalten darunter.
  if (req.query?.seo === '1') return serveProductPage(req, res);
  if (req.query?.sitemap === '1') return serveProductSitemap(req, res);
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  }

  res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0');

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'Datenbank ist nicht eingerichtet.' });
  }

  const id = req.query?.id;
  if (id != null && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))) {
    return res.status(400).json({ error: 'Ungültige Produkt-ID.' });
  }
  const imageRequest = req.query?.image === '1';
  if (imageRequest && !id) {
    return res.status(400).json({ error: 'Produkt-ID fehlt.' });
  }

  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);

    // Einzelnes Vorschaubild als echte Bilddatei statt als riesiges JSON.
    if (imageRequest) {
      const rows = await sql`
        SELECT to_jsonb(images)->>0 AS preview_image
        FROM products WHERE product_id = ${id}
      `;
      const value = rows[0]?.preview_image;
      if (typeof value !== 'string' || !value) {
        return res.status(404).json({ error: 'Produktbild nicht gefunden.' });
      }

      // Dateien aus dem bestehenden Ordner /bilder/ weiterverwenden.
      if (/^\/?bilder\/[a-zA-Z0-9_.\/-]+$/.test(value) && !value.includes('..')) {
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
        return res.redirect(302, '/' + value.replace(/^\//, ''));
      }

      const match = /^data:(image\/(?:jpeg|png|webp|gif|avif));base64,([a-zA-Z0-9+/=\r\n]+)$/i.exec(value);
      if (!match) {
        return res.status(415).json({ error: 'Bildformat nicht unterstützt.' });
      }
      const binary = Buffer.from(match[2], 'base64');
      res.setHeader('Content-Type', match[1].toLowerCase());
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).send(binary);
    }

    // Produktdetail: alle Fotos erst beim Öffnen nachladen.
    if (id) {
      const [rows, table] = await Promise.all([
        sql`SELECT product_id, images, updated_at FROM products WHERE product_id = ${id}`,
        sql`SELECT to_regclass('public.deleted_products') AS relation`
      ]);
      if (!rows.length) return res.status(404).json({ error: 'Produkt nicht gefunden.' });
      if (table[0]?.relation) {
        const tombstones = await sql`SELECT product_id FROM deleted_products WHERE product_id = ${id}`;
        if (tombstones.length) return res.status(404).json({ error: 'Produkt nicht gefunden.' });
      }
      const product = rows[0];
      return res.status(200).json({
        product_id: product.product_id,
        images: Array.isArray(product.images) ? product.images : [],
        updated_at: product.updated_at
      });
    }

    // Produktübersicht: Texte und Bildanzahl, aber keine Base64-Bilddaten.
    const [rows, table] = await Promise.all([
      sql`SELECT product_id, status, name, category, price, measure, description,
                 updated_at,
                 CASE WHEN jsonb_typeof(to_jsonb(images)) = 'array'
                      THEN jsonb_array_length(to_jsonb(images)) ELSE 0 END AS image_count
          FROM products ORDER BY updated_at DESC`,
      sql`SELECT to_regclass('public.deleted_products') AS relation`
    ]);
    const products = rows.map(({ image_count, ...record }) => {
      const imageCount = Number(image_count || 0);
      const previewUrl = '/api/products?image=1&id=' + encodeURIComponent(record.product_id) +
        '&v=' + encodeURIComponent(record.updated_at || '');
      return {
        ...record,
        images: imageCount > 0 ? [previewUrl] : [],
        imageCount
      };
    });
    const deletedIds = table[0]?.relation
      ? (await sql`SELECT product_id FROM deleted_products`).map(row => row.product_id)
      : [];
    return res.status(200).json({ products, deletedIds });
  } catch (error) {
    console.error('Produkte Fehler:', error);
    return res.status(500).json({ error: 'Produkte konnten nicht geladen werden.' });
  }
}
