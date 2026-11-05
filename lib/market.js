import { ensureCheckoutStock, refreshExpiredStripeClaims } from './checkout-stock.js';
// Admin-authenticated market operations; imported by the existing Vercel function.
const EVENT = 'advent-emkendorf-2026';
const WAYS = ['Mitgenommen', 'Zur Abholung', 'Zum Versand', 'Verschickt'];
// Match the shop's retired legacy articles; retain any existing sales history.
const RETIRED_PRODUCT_IDS = ['keramik-17', 'keramik-29', 'keramik-37', 'keramik-55'];
function fail(res, status, error) { return res.status(status).json({ error }); }
export function validSale(s) {
  return s && typeof s.id === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(s.id)
    && typeof s.productId === 'string' && s.productId.length <= 100
    && s.quantity === 1 && Number.isSafeInteger(s.total) && s.total >= 0 && s.total <= 1000000000
    && ['SumUp', 'PayPal', 'Bar'].includes(s.payment) && WAYS.includes(s.way)
    && /^2026-11-0[678]$/.test(s.day) && typeof s.note === 'string' && s.note.length <= 1500;
}
export async function snapshot(sql) {
  const products = await sql`SELECT product_id, name, category, price, status, updated_at::text AS shop_version FROM products ORDER BY updated_at DESC`;
  const sales = await sql`SELECT payload FROM market_sales WHERE event = ${EVENT} AND cancelled = FALSE ORDER BY created_at`;
  const records = sales.map(s => typeof s.payload === 'string' ? JSON.parse(s.payload) : s.payload);
  // Incomplete setup rows stay in administration, but cannot be offered for sale.
  const mapped = products.filter(p => !RETIRED_PRODUCT_IDS.includes(p.product_id))
    .filter(p => p.status !== 'available' ||
    (typeof p.name === 'string' && p.name.trim() && p.price != null &&
      Number.isSafeInteger(Number(p.price)) && Number(p.price) > 0))
    .map(p => ({ id: p.product_id, sku: p.product_id, name: p.name || p.product_id,
    category: p.category === 'Leder' || p.product_id.startsWith('leder-') ? 'Leder' : 'Keramik',
    price: Number(p.price), quantity: p.status === 'available' ? 1 : 0, shopVersion: p.shop_version, shopStatus: p.status }));
  // Keep history readable even when a product is later deleted in administration.
  for (const sale of records) if (!mapped.some(p => p.id === sale.productId)) mapped.push({
    id: sale.productId, sku: sale.productId, name: sale.name, category: sale.category,
    price: sale.total, quantity: 0, shopStatus: 'deleted', shopVersion: ''
  });
  return { version: 1, products: mapped, sales: records };
}
export async function marketHandler(req, res, sql) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'POST'].includes(req.method)) return fail(res, 405, 'Methode nicht erlaubt.');
  if (req.method === 'POST') {
    // Same-origin admin popup only. No cross-site cookies, secrets or CORS grants.
    if (!['https://dragemor-pottery.de', 'https://www.dragemor-pottery.de'].includes(req.headers.origin)) {
      return fail(res, 403, 'Bitte den Abgleich über die Shop-Verwaltung öffnen.');
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return fail(res, 415, 'JSON erforderlich.');
  }
  await sql`CREATE TABLE IF NOT EXISTS market_sales (
    id TEXT PRIMARY KEY, event TEXT NOT NULL, product_id TEXT NOT NULL,
    payload JSONB NOT NULL, claim_updated_at TIMESTAMPTZ NOT NULL,
    cancelled BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  if (req.method === 'GET') return res.status(200).json(await snapshot(sql));
  const { action, sale, id, productVersion } = req.body || {};
  if (action === 'sale') {
    if (!validSale(sale) || typeof productVersion !== 'string' || !Number.isFinite(Date.parse(productVersion))) return fail(res, 400, 'Ungültige Verkaufsdaten. Shop-Produkte sind Einzelstücke.');
    await ensureCheckoutStock(sql);
    await refreshExpiredStripeClaims(sql, false);
    const prior = await sql`SELECT id, cancelled FROM market_sales WHERE id = ${sale.id} AND event = ${EVENT}`;
    if (prior.length) {
      if (prior[0].cancelled) return fail(res, 409, 'Dieser Verkauf wurde bereits storniert.');
      return res.status(200).json(await snapshot(sql));
    }
    const payload = { id: sale.id, productId: sale.productId, quantity: 1, total: sale.total,
      payment: sale.payment, way: sale.way, day: sale.day, note: sale.note,
      time: new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date()) };
    const created = await sql`WITH claimed AS (
      UPDATE products SET status = 'sold', updated_at = NOW()
      WHERE product_id = ${sale.productId} AND status = 'available' AND updated_at = ${productVersion}::timestamptz
        AND NULLIF(BTRIM(name), '') IS NOT NULL AND price > 0
        AND NOT (product_id = ANY(${RETIRED_PRODUCT_IDS}::text[]))
        AND NOT EXISTS (SELECT 1 FROM stripe_stock_claims WHERE status = 'active' AND ${sale.productId} = ANY(product_ids))
      RETURNING product_id, name, category, updated_at
    ) INSERT INTO market_sales (id, event, product_id, payload, claim_updated_at)
      SELECT ${sale.id}, ${EVENT}, product_id,
        ${JSON.stringify(payload)}::jsonb || jsonb_build_object('name', COALESCE(name, product_id), 'category',
          CASE WHEN category = 'Leder' OR product_id LIKE 'leder-%' THEN 'Leder' ELSE 'Keramik' END), updated_at
      FROM claimed RETURNING id`;
    if (!created.length) return fail(res, 409, 'Der Artikel ist ausgemustert oder unvollständig, wurde inzwischen verkauft, geändert oder ist in einem offenen Bezahlvorgang. Bitte Bestand neu abgleichen.');
  } else if (action === 'update-sale') {
    if (typeof id !== 'string' || !['SumUp', 'PayPal', 'Bar'].includes(sale?.payment) || !WAYS.includes(sale?.way)
      || typeof sale?.note !== 'string' || sale.note.length > 1500) return fail(res, 400, 'Ungültige Übergabedaten.');
    const changes = JSON.stringify({ payment: sale.payment, way: sale.way, note: sale.note });
    const changed = await sql`UPDATE market_sales SET payload = payload || ${changes}::jsonb, updated_at = NOW()
      WHERE id = ${id} AND event = ${EVENT} AND cancelled = FALSE RETURNING id`;
    if (!changed.length) return fail(res, 409, 'Verkauf nicht mehr vorhanden. Bitte neu abgleichen.');
  } else if (action === 'cancel-sale') {
    if (typeof id !== 'string') return fail(res, 400, 'Verkaufs-ID fehlt.');
    const cancelled = await sql`WITH locked AS (
      SELECT * FROM market_sales WHERE id = ${id} AND event = ${EVENT} FOR UPDATE
    ), restored AS (
      UPDATE products p SET status = 'available', updated_at = NOW() FROM locked s
      WHERE p.product_id = s.product_id AND s.cancelled = FALSE
        AND p.status = 'sold' AND p.updated_at = s.claim_updated_at RETURNING p.product_id
    ) UPDATE market_sales SET cancelled = TRUE, updated_at = NOW()
      WHERE id = ${id} AND event = ${EVENT} AND EXISTS (SELECT 1 FROM restored) RETURNING id`;
    if (!cancelled.length) {
      const prior = await sql`SELECT cancelled FROM market_sales WHERE id = ${id} AND event = ${EVENT}`;
      if (!prior[0]?.cancelled) return fail(res, 409, 'Der Shop-Artikel wurde nach dem Verkauf geändert. Bitte in der Verwaltung prüfen; es wurde nichts überschrieben.');
    }
  } else return fail(res, 400, 'Unbekannte Marktaktion.');
  return res.status(200).json(await snapshot(sql));
}
