import crypto from 'node:crypto';

export async function ensureCheckoutStock(sql) {
  await sql`CREATE TABLE IF NOT EXISTS stripe_stock_claims (
    id TEXT PRIMARY KEY, product_ids TEXT[] NOT NULL, session_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS checkout_stock_guard (id INTEGER PRIMARY KEY CHECK (id = 1), started_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`INSERT INTO checkout_stock_guard (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
}

export async function checkoutStockReady(sql) {
  const rows = await sql`SELECT (started_at <= NOW() - INTERVAL '24 hours') AS ready FROM checkout_stock_guard WHERE id = 1`;
  return rows[0]?.ready === true;
}

export async function reserveStripeStock(sql, selected) {
  await ensureCheckoutStock(sql);
  await refreshExpiredStripeClaims(sql);
  const id = crypto.randomUUID();
  const items = selected.map(i => ({ id: i.id, price: i.product.amount, version: i.product.stockVersion }));
  const ids = items.map(i => i.id);
  // Both providers lock the same product rows. Bumping their versions makes a
  // PayPal transaction with an older MVCC snapshot fail safely after waiting.
  const claimed = await sql`WITH stock AS MATERIALIZED (
    SELECT product_id, price, status, updated_at FROM products WHERE product_id = ANY(${ids})
    ORDER BY product_id FOR UPDATE
  ), eligible AS (
    SELECT 1 WHERE (SELECT COUNT(*) FROM stock) = ${items.length}
      AND NOT EXISTS (SELECT 1 FROM stock p
        JOIN jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS wanted(id text, price integer, version text) ON p.product_id = wanted.id
        WHERE p.status <> 'available' OR p.price <> wanted.price OR p.updated_at <> wanted.version::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM stripe_stock_claims WHERE status = 'active' AND product_ids && ${ids}::text[])
  ), touched AS (
    UPDATE products SET updated_at = NOW() WHERE product_id = ANY(${ids}) AND EXISTS (SELECT 1 FROM eligible) RETURNING product_id
  ) INSERT INTO stripe_stock_claims (id, product_ids)
    SELECT ${id}, ${ids}::text[] WHERE EXISTS (SELECT 1 FROM eligible) RETURNING id`;
  if (!claimed.length) throw Object.assign(new Error('Ein Artikel wurde inzwischen geändert, verkauft oder ist bereits in einem Bezahlvorgang. Bitte versuche es später erneut.'), {status:409});
  return id;
}

export async function releaseStripeStock(sql, sessionId) {
  await ensureCheckoutStock(sql);
  await sql`UPDATE stripe_stock_claims SET status = 'released' WHERE session_id = ${sessionId} AND status = 'active'`;
}

export async function refreshExpiredStripeClaims(sql, sandbox = process.env.VERCEL_ENV === 'preview') {
  const secret = sandbox ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY;
  if (!secret) return;
  const stale = await sql`SELECT id, session_id FROM stripe_stock_claims WHERE status = 'active'
    AND session_id IS NOT NULL AND created_at < NOW() - INTERVAL '35 minutes' ORDER BY created_at LIMIT 8`;
  await Promise.allSettled(stale.map(async claim => {
    try {
      const response = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(claim.session_id), {
        headers: { Authorization: 'Bearer ' + secret }, signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) return;
      const session = await response.json();
      if (session.id === claim.session_id && session.status === 'expired' && session.payment_status !== 'paid') {
        await sql`UPDATE stripe_stock_claims SET status = 'released' WHERE id = ${claim.id} AND status = 'active'`;
      }
    } catch { /* An uncertain Stripe result must never release stock. */ }
  }));
}
