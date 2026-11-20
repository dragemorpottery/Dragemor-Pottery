import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { loadPublishedProducts, serveProductOverview } from '../lib/seo.js';

const response = () => ({
  headers: {}, setHeader(k, v) { this.headers[k] = v; },
  status(code) { this.code = code; return this; },
  send(body) { this.body = body; return this; }
});

test('overview serves crawlable current products without JavaScript and excludes unpublished stock', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE products (product_id text, name text, category text, price integer,
      status text, measure text, description text, images jsonb, updated_at timestamptz DEFAULT now());
      CREATE TABLE deleted_products (product_id text);
      INSERT INTO products (product_id,name,price,status,images) VALUES
      ('produkt-new','Tasse <Liebe> & Ruhe',1800,'available','["bild.webp"]'),
      ('keramik-4','Vase',2100,'available','[]'),
      ('produkt-sold','Verkauft',1800,'sold','["bild.webp"]'),
      ('produkt-deleted','Entfernt',1800,'available','["bild.webp"]'),
      ('produkt-no-price','Ohne Preis',NULL,'available','["bild.webp"]'),
      ('produkt-no-photo','Ohne Bild',1800,'available','[]'),
      ('produkt-no-name',' ',1800,'available','["bild.webp"]'),
      ('market-only','Marktartikel',1800,'available','["bild.webp"]'),
      ('produkt-<bad>','Ungültig',1800,'available','["bild.webp"]'),
      ('keramik-37','Ausgemustert',1800,'available','["bild.webp"]');
      INSERT INTO deleted_products VALUES ('produkt-deleted');`);
    const sql = { query: async (q, params) => (await db.query(q, params)).rows };
    const products = await loadPublishedProducts(sql);
    assert.deepEqual(new Set(products.map(p => p.product_id)), new Set(['produkt-new', 'keramik-4']));
    const res = response();
    await serveProductOverview({ method: 'GET' }, res, { sql });
    assert.equal(res.code, 200);
    assert.match(res.body, /<a class="piece" href="\/produkt\/produkt-new">/);
    assert.match(res.body, /Tasse &lt;Liebe&gt; &amp; Ruhe/);
    assert.match(res.body, /18,00\s*€/);
    assert.match(res.body, /src="\/bilder\/Keramik04.jpg"/);
    assert.match(res.body, /rel="canonical" href="https:\/\/www.dragemor-pottery.de\/produkte"/);
    assert.doesNotMatch(res.body, /<script|produkt-sold|produkt-deleted|produkt-no-/);
    // A later sale must disappear from the next server response.
    await db.exec("UPDATE products SET status='sold' WHERE product_id='produkt-new'");
    const afterSale = response();
    await serveProductOverview({ method: 'GET' }, afterSale, { sql });
    assert.doesNotMatch(afterSale.body, /\/produkt\/produkt-new/);
    await db.exec('DROP TABLE deleted_products');
    assert.equal((await loadPublishedProducts(sql)).length, 2); // optional legacy table
  } finally { await db.close(); }
});

test('overview rejects writes without accessing the catalog', async () => {
  const res = response();
  await serveProductOverview({ method: 'POST' }, res, { sql: { query() { throw new Error('must not query'); } } });
  assert.equal(res.code, 405);
  assert.equal(res.headers.Allow, 'GET');
});
