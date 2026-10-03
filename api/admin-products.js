import crypto from "crypto";

const preparedVouchers = [
  { code: "DRG-A7KM-4QPX-15", value: 1500 },
  { code: "DRG-B9LR-6TWM-15", value: 1500 },
  { code: "DRG-C4NP-8VKR-15", value: 1500 },
  { code: "DRG-D6QW-3XMT-15", value: 1500 },
  { code: "DRG-E8TK-7ZRP-15", value: 1500 },

  { code: "DRG-F3LM-9QKV-25", value: 2500 },
  { code: "DRG-G7NP-2WRT-25", value: 2500 },
  { code: "DRG-H4RX-8KMP-25", value: 2500 },
  { code: "DRG-J6TV-5LQN-25", value: 2500 },
  { code: "DRG-K8WM-1PRT-25", value: 2500 },

  { code: "DRG-L5QK-7XNP-50", value: 5000 },
  { code: "DRG-M9RT-3KVL-50", value: 5000 },
  { code: "DRG-N4PW-8TMQ-50", value: 5000 },
  { code: "DRG-P7LX-2RKN-50", value: 5000 },
  { code: "DRG-Q3VM-6WTP-50", value: 5000 }
];

function createToken() {
  return crypto
    .createHmac("sha256", process.env.ADMIN_PASSWORD)
    .update("dragemor-admin")
    .digest("hex");
}

function isAdmin(req) {
  if (!process.env.ADMIN_PASSWORD) return false;

  const cookies = req.headers.cookie || "";

  const adminCookie = cookies
    .split(";")
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith("dragemor_admin="));

  if (!adminCookie) return false;

  const token = adminCookie.substring("dragemor_admin=".length);
  return token === createToken();
}

async function ensureVoucherTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS vouchers (
      code TEXT PRIMARY KEY,
      initial_value INTEGER NOT NULL CHECK (initial_value > 0),
      balance INTEGER NOT NULL CHECK (balance >= 0),
      status TEXT NOT NULL DEFAULT 'prepared',
      source TEXT NOT NULL DEFAULT 'market',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      redeemed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reserved_amount INTEGER NOT NULL DEFAULT 0,
      reservation_token TEXT,
      reserved_session_id TEXT,
      reserved_until TIMESTAMPTZ
    )
  `;

  await sql`ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS reserved_amount INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS reservation_token TEXT`;
  await sql`ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS reserved_session_id TEXT`;
  await sql`ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ`;

  await sql`
    CREATE TABLE IF NOT EXISTS voucher_redemptions (
      stripe_session_id TEXT PRIMARY KEY,
      voucher_code TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function seedPreparedVouchers(sql) {
  await ensureVoucherTables(sql);

  for (const voucher of preparedVouchers) {
    await sql`
      INSERT INTO vouchers (
        code,
        initial_value,
        balance,
        status,
        source
      )
      VALUES (
        ${voucher.code},
        ${voucher.value},
        ${voucher.value},
        'prepared',
        'market'
      )
      ON CONFLICT (code) DO NOTHING
    `;
  }
}

async function clearExpiredVoucherReservations(sql) {
  await sql`
    UPDATE vouchers
    SET
      reserved_amount = 0,
      reservation_token = NULL,
      reserved_session_id = NULL,
      reserved_until = NULL,
      updated_at = NOW()
    WHERE reservation_token IS NOT NULL
      AND reserved_until IS NOT NULL
      AND reserved_until < NOW()
  `;
}

function nurErstesVorschaubild(images) {
  if (Array.isArray(images)) {
    return images.length ? [images[0]] : [];
  }

  if (images) {
    return [images];
  }

  return [];
}

export default async function handler(req, res) {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "Nicht angemeldet." });
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return res.status(500).json({ error: "Datenbank ist nicht eingerichtet." });
  }

  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl);

    // ===== GUTSCHEINE =====
    if (req.method === "GET" && req.query?.resource === "vouchers") {
      await seedPreparedVouchers(sql);
      await clearExpiredVoucherReservations(sql);

      const vouchers = await sql`
        SELECT
          code,
          initial_value,
          balance,
          status,
          source,
          created_at,
          activated_at,
          redeemed_at,
          updated_at,
          reserved_amount,
          reserved_until
        FROM vouchers
        ORDER BY initial_value, code
      `;

      return res.status(200).json({ vouchers });
    }

    if (req.method === "POST" && req.body?.action === "activate-voucher") {
      await seedPreparedVouchers(sql);
      await clearExpiredVoucherReservations(sql);

      const code = String(req.body?.code || "").trim().toUpperCase();
      if (!code) return res.status(400).json({ error: "Gutscheincode fehlt." });

      const updated = await sql`
        UPDATE vouchers
        SET
          status = 'active',
          activated_at = COALESCE(activated_at, NOW()),
          updated_at = NOW()
        WHERE code = ${code}
          AND balance > 0
          AND status IN ('prepared', 'disabled')
        RETURNING *
      `;

      if (!updated.length) {
        return res.status(409).json({ error: "Der Gutschein konnte nicht aktiviert werden." });
      }

      return res.status(200).json({ ok: true, voucher: updated[0] });
    }

    if (req.method === "POST" && req.body?.action === "prepare-voucher") {
      await seedPreparedVouchers(sql);
      await clearExpiredVoucherReservations(sql);

      const code = String(req.body?.code || "").trim().toUpperCase();
      if (!code) return res.status(400).json({ error: "Gutscheincode fehlt." });

      const updated = await sql`
        UPDATE vouchers v
        SET
          status = 'prepared',
          activated_at = NULL,
          updated_at = NOW()
        WHERE v.code = ${code}
          AND v.balance = v.initial_value
          AND v.reservation_token IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM voucher_redemptions r
            WHERE r.voucher_code = v.code
          )
        RETURNING *
      `;

      if (!updated.length) {
        return res.status(409).json({
          error: "Die Aktivierung kann nur bei einem noch unbenutzten Gutschein rückgängig gemacht werden."
        });
      }

      return res.status(200).json({ ok: true, voucher: updated[0] });
    }

    if (req.method === "POST" && req.body?.action === "disable-voucher") {
      await seedPreparedVouchers(sql);
      await clearExpiredVoucherReservations(sql);

      const code = String(req.body?.code || "").trim().toUpperCase();
      if (!code) return res.status(400).json({ error: "Gutscheincode fehlt." });

      const updated = await sql`
        UPDATE vouchers
        SET status = 'disabled', updated_at = NOW()
        WHERE code = ${code}
          AND balance > 0
          AND reservation_token IS NULL
        RETURNING *
      `;

      if (!updated.length) {
        return res.status(409).json({ error: "Der Gutschein konnte nicht gesperrt werden." });
      }

      return res.status(200).json({ ok: true, voucher: updated[0] });
    }

    // ===== PRODUKTE =====
    if (req.method === "GET") {
      const category = String(req.query?.category || "").trim();
      const previewOnly = String(req.query?.preview || "") === "1";

      const products = category
        ? await sql`
            SELECT product_id, status, updated_at, name, category, price, measure, description, images
            FROM products
            WHERE category = ${category}
            ORDER BY product_id
          `
        : await sql`
            SELECT product_id, status, updated_at, name, category, price, measure, description, images
            FROM products
            ORDER BY product_id
          `;

      const responseProducts = previewOnly
        ? products.map(product => ({
            ...product,
            images: nurErstesVorschaubild(product.images)
          }))
        : products;

      return res.status(200).json({ products: responseProducts });
    }

    if (req.method === "POST" && req.body?.action === "create-product") {
      const {
        product_id,
        name,
        category,
        price,
        measure,
        description,
        images
      } = req.body;

      if (!product_id || !name || !category || price === undefined) {
        return res.status(400).json({ error: "Bitte alle Pflichtfelder ausfüllen." });
      }

      const created = await sql`
        INSERT INTO products (
          product_id,
          status,
          name,
          category,
          price,
          measure,
          description,
          images
        )
        VALUES (
          ${product_id},
          'available',
          ${name},
          ${category},
          ${price},
          ${measure || null},
          ${description || null},
          ${images || []}
        )
        RETURNING *
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS deleted_products (
          product_id TEXT PRIMARY KEY,
          deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`DELETE FROM deleted_products WHERE product_id = ${product_id}`;

      return res.status(201).json({ ok: true, product: created[0] });
    }

    if (req.method === "POST" && req.body?.action === "update-product") {
      const {
        product_id,
        name,
        category,
        price,
        measure,
        description,
        images
      } = req.body;

      if (!product_id || !name || !category || price === undefined) {
        return res.status(400).json({ error: "Bitte alle Pflichtfelder ausfüllen." });
      }

      const updated = images
        ? await sql`
            UPDATE products
            SET
              name = ${name},
              category = ${category},
              price = ${price},
              measure = ${measure || null},
              description = ${description || null},
              images = ${images},
              updated_at = NOW()
            WHERE product_id = ${product_id}
            RETURNING *
          `
        : await sql`
            UPDATE products
            SET
              name = ${name},
              category = ${category},
              price = ${price},
              measure = ${measure || null},
              description = ${description || null},
              updated_at = NOW()
            WHERE product_id = ${product_id}
            RETURNING *
          `;

      return res.status(200).json({ ok: true, product: updated[0] });
    }

    if (req.method === "POST" && req.body?.action === "delete-product") {
      const { product_id } = req.body;

      if (!product_id) {
        return res.status(400).json({ error: "Produkt-ID fehlt." });
      }

      await sql`
        CREATE TABLE IF NOT EXISTS deleted_products (
          product_id TEXT PRIMARY KEY,
          deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      const deleted = await sql`
        WITH removed AS (
          DELETE FROM products
          WHERE product_id = ${product_id}
          RETURNING product_id
        )
        INSERT INTO deleted_products (product_id, deleted_at)
        SELECT product_id, NOW() FROM removed
        ON CONFLICT (product_id) DO UPDATE SET deleted_at = NOW()
        RETURNING product_id
      `;

      if (deleted.length === 0) {
        return res.status(404).json({ error: "Produkt wurde nicht gefunden." });
      }

      return res.status(200).json({ ok: true, product_id: deleted[0].product_id });
    }

    if (req.method === "POST") {
      const { product_id, status } = req.body || {};

      if (!product_id) {
        return res.status(400).json({ error: "Produkt-ID fehlt." });
      }

      if (!["available", "sold"].includes(status)) {
        return res.status(400).json({ error: "Ungültiger Status." });
      }

      const updated = await sql`
        UPDATE products
        SET
          status = ${status},
          updated_at = NOW()
        WHERE product_id = ${product_id}
        RETURNING product_id, status, updated_at
      `;

      if (updated.length === 0) {
        return res.status(404).json({ error: "Produkt wurde nicht gefunden." });
      }

      return res.status(200).json({ ok: true, product: updated[0] });
    }

    return res.status(405).json({ error: "Methode nicht erlaubt." });
  } catch (error) {
    console.error("Admin-Produkte/Gutscheine Fehler:", error);
    return res.status(500).json({
      error: "Produkte oder Gutscheine konnten nicht verarbeitet werden."
    });
  }
}
