// Dynamische Sitemap: nur derzeit verfügbare, echte Produkte.
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Methode nicht erlaubt');
  }
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
  if (!process.env.DATABASE_URL) {
    return res.status(503).send('Sitemap vorübergehend nicht verfügbar.');
  }
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql.query(
      "SELECT product_id, updated_at FROM products WHERE status = 'available' ORDER BY product_id"
    );
    const entries = rows
      .filter(row => /^[A-Za-z0-9_-]{1,100}$/.test(String(row.product_id)))
      .map(row => {
        const url = 'https://www.dragemor-pottery.de/produkt/' + encodeURIComponent(row.product_id);
        const updated = row.updated_at ? new Date(row.updated_at) : null;
        const lastmod = updated && !Number.isNaN(updated.getTime())
          ? '<lastmod>' + updated.toISOString().slice(0, 10) + '</lastmod>' : '';
        return '  <url><loc>' + url + '</loc>' + lastmod + '</url>';
      });
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...entries,
      '</urlset>'
    ].join('\n');
    return res.status(200).send(xml);
  } catch (err) {
    console.error('Produkt-Sitemap:', err);
    return res.status(503).send('Sitemap vorübergehend nicht verfügbar.');
  }
}
