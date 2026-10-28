// Eigenständige, serverseitig gerenderte Produktseiten für Google und Kundinnen/Kunden.
// Bestehende Shop-Funktionen und Checkout bleiben auf der Startseite.
import { neon } from '@neondatabase/serverless';

const BASE = 'https://www.dragemor-pottery.de';

const fallbackPhotos = {
  "keramik-1": "bilder/Keramik01.jpg",
  "keramik-4": "bilder/Keramik04.jpg",
  "keramik-7": "bilder/Keramik07.jpg",
  "keramik-9": "bilder/Keramik09.jpg",
  "keramik-12": "bilder/Keramik012.jpg",
  "keramik-14": "bilder/Keramik014.jpg",
  "keramik-22": "bilder/Keramik022.jpg",
  "keramik-24": "bilder/Keramik024.jpg",
  "keramik-30": "bilder/Keramik030.jpg",
  "keramik-33": "bilder/Keramik033.jpg",
  "keramik-37": "bilder/Keramik037.jpg",
  "keramik-40": "bilder/Keramik040.jpg",
  "keramik-49": "bilder/Keramik049.jpg",
  "keramik-56": "bilder/Keramik056.jpg",
  "keramik-58": "bilder/Keramik058.jpg",
  "leder-1": "bilder/leder-galerie-01.jpg",
  "leder-2": "bilder/leder-galerie-02.jpg",
  "leder-3": "bilder/leder-galerie-03.jpg",
  "leder-4": "bilder/leder-galerie-04.jpg",
  "leder-5": "bilder/leder-galerie-05.jpg",
  "leder-6": "bilder/leder-galerie-06.jpg",
  "leder-7": "bilder/leder-galerie-07.jpg",
  "leder-8": "bilder/leder-galerie-08.jpg",
  "leder-9": "bilder/leder-galerie-09.jpg",
  "leder-10": "bilder/leder-galerie-10.jpg",
  "leder-11": "bilder/leder-galerie-11.jpg",
  "leder-12": "bilder/leder-galerie-12.jpg"
};
const publishedLegacyProductIds = new Set(["keramik-1","keramik-4","keramik-7","keramik-9","keramik-12","keramik-14","keramik-22","keramik-24","keramik-26","keramik-30","keramik-33","keramik-37","keramik-40","keramik-49","keramik-53","keramik-56","keramik-58","leder-1","leder-2","leder-3","leder-4","leder-5","leder-6","leder-7","leder-8","leder-9","leder-10","leder-11","leder-12"]);
// IDs, die vom bestehenden Checkout ausdrücklich ausgemustert wurden.
const retiredProductIds = new Set(['keramik-17','keramik-29','keramik-37','keramik-55']);

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function renderProduct(product) {
  const id = String(product.product_id);
  const name = String(product.name || 'Handgemachtes Keramikstück').trim();
  const category = String(product.category || 'Keramik').trim();
  const description = String(product.description || 'Ein liebevoll von Hand gefertigtes Einzelstück aus der Dragemor Pottery Manufaktur.').trim();
  const summary = description.replace(/\s+/g, ' ').slice(0, 155);
  const title = name + ' | Dragemor Pottery';
  const url = BASE + '/produkt/' + encodeURIComponent(id);
  const shopUrl = BASE + '/#' + encodeURIComponent(id);
  const hasDatabaseImage = Number(product.image_count || 0) > 0;
  // Ältere Artikel haben ihre Fotos noch als lokale Bilddateien – auch in der Verwaltung.
  const legacyPhoto = fallbackPhotos[id] || '';
  const image = hasDatabaseImage
    ? BASE + '/api/products?image=1&id=' + encodeURIComponent(id)
    : legacyPhoto ? BASE + '/' + legacyPhoto : '';
  const hasImage = Boolean(image);
  const available = String(product.status).toLowerCase() === 'available';
  // Alle Produktpreise stehen in der Datenbank in Cent, wie beim Stripe-Checkout.
  const priceInCents = Number(product.price);
  const validPrice = Number.isInteger(priceInCents) && priceInCents > 0;
  const price = priceInCents / 100;
  const priceLabel = validPrice ? price.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }) : '';
  const detail = String(product.measure || '').trim();
  const productJson = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    description: description.slice(0, 4000),
    sku: id,
    url,
    brand: { '@type': 'Brand', name: 'Dragemor Pottery' },
    ...(hasImage ? { image: [image] } : {}),
    ...(validPrice ? { offers: {
      '@type': 'Offer',
      price: price.toFixed(2),
      priceCurrency: 'EUR',
      availability: available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: shopUrl,
      itemCondition: 'https://schema.org/NewCondition'
    }} : {})
  };
  const json = JSON.stringify(productJson).replace(/</g, '\\u003c');
  const photo = hasImage
    ? '<img class="product-photo" src="' + esc(image) + '" alt="' + esc(name) + ' – handgemachtes Einzelstück" loading="eager">'
    : '<div class="placeholder" aria-label="Noch kein Produktfoto">Dragemor Pottery</div>';
  const availability = available ? 'Einzelstück verfügbar' : 'Dieses Einzelstück ist derzeit nicht verfügbar';
  const action = available ? 'Dieses Stück im Shop ansehen' : 'Weitere Keramik entdecken';
  const destination = available ? shopUrl : BASE + '/';
  return [
    '<!doctype html><html lang="de"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="' + (available && validPrice && hasImage && name ? 'index,follow' : 'noindex,follow') + '">',
    '<title>' + esc(title) + '</title>',
    '<meta name="description" content="' + esc(summary) + '">',
    '<link rel="canonical" href="' + esc(url) + '">',
    '<meta property="og:type" content="product">',
    '<meta property="og:title" content="' + esc(title) + '">',
    '<meta property="og:description" content="' + esc(summary) + '">',
    '<meta property="og:url" content="' + esc(url) + '">',
    (hasImage ? '<meta property="og:image" content="' + esc(image) + '">' : ''),
    '<script type="application/ld+json">' + json + '</script>',
    '<style>',
    '*{box-sizing:border-box}body{margin:0;background:#f8f6f1;color:#26362e;font-family:Georgia,serif;line-height:1.65}',
    'a{color:inherit}header{padding:19px 5vw;background:#344e40;color:#fff}header a{text-decoration:none;letter-spacing:.18em;font-size:1.3rem}',
    'main{max-width:1060px;margin:54px auto;padding:0 24px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:48px;align-items:start}',
    '.product-photo,.placeholder{width:100%;display:block;object-fit:contain;max-height:640px;border-radius:14px;background:#eae8de}',
    '.placeholder{aspect-ratio:1;display:flex;align-items:center;justify-content:center;color:#687869;font-size:1.5rem;letter-spacing:.1em}',
    '.eyebrow{text-transform:uppercase;letter-spacing:.18em;font:12px Arial,sans-serif;color:#667c70}',
    'h1{font-weight:400;line-height:1.2;font-size:clamp(2.2rem,4vw,3.4rem);margin:14px 0 20px}',
    '.details{white-space:pre-line;overflow-wrap:anywhere}.price{font-size:1.45rem;margin:18px 0}',
    '.availability{color:#536f5a;font:14px Arial,sans-serif;margin:16px 0}',
    '.button{display:inline-block;background:#344e40;color:#fff;padding:14px 22px;border-radius:5px;text-decoration:none;margin-top:18px;font:14px Arial,sans-serif}',
    '.button:focus,.button:hover{background:#263a30}.back{display:block;margin-top:28px;font:13px Arial,sans-serif}',
    'footer{padding:35px 24px;text-align:center;color:#65776d;font-size:13px}',
    '@media(max-width:720px){main{grid-template-columns:1fr;margin:25px auto;gap:26px}header a{font-size:1rem}}',
    '</style></head><body>',
    '<header><a href="' + BASE + '/">DRAGEMOR POTTERY</a></header>',
    '<main><section>' + photo + '</section><section>',
    '<div class="eyebrow">Handgemachte Einzelstücke · ' + esc(category) + '</div>',
    '<h1>' + esc(name) + '</h1>',
    (detail ? '<p class="eyebrow">' + esc(detail) + '</p>' : ''),
    '<div class="details">' + esc(description) + '</div>',
    (priceLabel ? '<div class="price">' + esc(priceLabel) + '</div>' : ''),
    '<p class="availability">' + esc(availability) + '</p>',
    '<a class="button" href="' + esc(destination) + '">' + esc(action) + '</a>',
    '<a class="back" href="' + BASE + '/">← Zurück zu Dragemor Pottery</a>',
    '</section></main><footer>Mit Liebe von Hand gefertigt · Dragemor Pottery</footer>',
    '</body></html>'
  ].join('\n');
}

export async function serveProductPage(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Methode nicht erlaubt');
  }
  const id = req.query?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    return res.status(404).send('Produkt nicht gefunden');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60');
  if (!process.env.DATABASE_URL) {
    return res.status(503).send('Der Produktkatalog ist derzeit nicht verfügbar.');
  }
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql.query(
      "SELECT product_id, status, name, category, price, measure, description, " +
      "CASE WHEN jsonb_typeof(to_jsonb(images)) = 'array' " +
      "THEN jsonb_array_length(to_jsonb(images)) ELSE 0 END AS image_count " +
      "FROM products WHERE product_id = $1 LIMIT 1",
      [id]
    );
    if (!rows.length) {
      res.setHeader('X-Robots-Tag', 'noindex');
      return res.status(404).send('Produkt nicht gefunden');
    }
    return res.status(200).send(renderProduct(rows[0]));
  } catch (err) {
    console.error('Produktseite:', err);
    return res.status(503).send('Produktseite vorübergehend nicht erreichbar.');
  }
}


// Dynamische Sitemap: nur derzeit verfügbare, echte Produkte.


export async function serveProductSitemap(req, res) {
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
      "SELECT product_id, updated_at, name, price, " +
      "CASE WHEN jsonb_typeof(to_jsonb(images)) = 'array' " +
      "THEN jsonb_array_length(to_jsonb(images)) ELSE 0 END AS image_count " +
      "FROM products WHERE status = 'available' ORDER BY product_id"
    );
    const entries = rows
      // Nur tatsächlich im Shop angebotene Artikel mit Namen, Preis und Foto einreichen.
      .filter(row => {
        const id = String(row.product_id);
        const listed = id.startsWith('produkt-') || publishedLegacyProductIds.has(id);
        const pictureAvailable = Number(row.image_count || 0) > 0 || Boolean(fallbackPhotos[id]);
        return /^[A-Za-z0-9_-]{1,100}$/.test(id) && listed &&
          !retiredProductIds.has(id) &&
          Boolean(String(row.name || '').trim()) &&
          Number.isInteger(Number(row.price)) && Number(row.price) > 0 && pictureAvailable;
      })
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
