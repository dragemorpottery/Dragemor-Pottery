import crypto from "crypto";

// The original legacy catalog is retained for items which have NEVER been
// managed in Neon. A formerly managed item must have an active DB row.

const retiredLegacyIds = new Set([
  "keramik-17", "keramik-017", "keramik-29", "keramik-029",
  "keramik-37", "keramik-037", "keramik-55", "keramik-055"
]);

function normalizeVoucherInput(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 80);
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

async function findVoucher(sql, voucherInput) {
  const normalized = normalizeVoucherInput(voucherInput);
  if (!normalized) return null;

  const rows = await sql`
    SELECT
      code,
      initial_value,
      balance,
      status,
      reserved_amount,
      reservation_token,
      reserved_session_id,
      reserved_until
    FROM vouchers
    WHERE regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') = ${normalized}
    LIMIT 1
  `;

  return rows[0] || null;
}

async function releaseVoucherReservation(sql, token) {
  if (!token) return;

  await sql`
    UPDATE vouchers
    SET
      reserved_amount = 0,
      reservation_token = NULL,
      reserved_session_id = NULL,
      reserved_until = NULL,
      updated_at = NOW()
    WHERE reservation_token = ${token}
  `;
}

async function getStripeCheckoutSession(stripeSecretKey, sessionId) {
  if (!sessionId) return null;

  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`
      }
    }
  );

  if (!response.ok) return null;
  return await response.json();
}

async function expireStripeCheckoutSession(stripeSecretKey, sessionId) {
  if (!sessionId) return false;

  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: ""
    }
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      data?.error?.message ||
      "Der vorherige Stripe-Bezahlvorgang konnte nicht beendet werden."
    );
  }

  return true;
}

async function createStripeCoupon(stripeSecretKey, voucher) {
  const params = new URLSearchParams();
  params.set("currency", "eur");
  params.set("amount_off", String(voucher.discount));
  params.set("duration", "once");
  params.set("max_redemptions", "1");
  params.set("name", `Dragemor Gutschein ${voucher.code}`);
  params.set("metadata[dragemor_voucher_code]", voucher.code);

  const response = await fetch("https://api.stripe.com/v1/coupons", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  const data = await response.json();
  if (!response.ok || !data?.id) {
    throw new Error(data?.error?.message || "Gutschein konnte bei Stripe nicht vorbereitet werden.");
  }

  return data.id;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Methode nicht erlaubt." });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: "Datenbank ist noch nicht vollständig eingerichtet." });
  }

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);

  try {
    await ensureVoucherTables(sql);
    await clearExpiredVoucherReservations(sql);
  } catch (error) {
    console.error("Gutscheintabelle konnte nicht vorbereitet werden:", error);
    return res.status(500).json({ error: "Das Gutscheinsystem konnte nicht geladen werden." });
  }

  const action = String(req.body?.action || "");

  if (action === "check-voucher") {
    const voucher = await findVoucher(sql, req.body?.voucherCode);

    if (!voucher) {
      return res.status(404).json({ error: "Dieser Gutscheincode wurde nicht gefunden." });
    }
    if (voucher.status === "prepared") {
      return res.status(409).json({ error: "Dieser Gutschein wurde noch nicht aktiviert." });
    }
    if (voucher.status === "redeemed" || Number(voucher.balance) <= 0) {
      return res.status(409).json({ error: "Dieser Gutschein wurde bereits vollständig eingelöst." });
    }
    if (voucher.status !== "active") {
      return res.status(409).json({ error: "Dieser Gutschein ist momentan nicht einlösbar." });
    }
    if (voucher.reservation_token && voucher.reserved_until) {
      const isPreview = process.env.VERCEL_ENV === "preview";
      const stripeSecretKey = isPreview
        ? process.env.STRIPE_TEST_SECRET_KEY
        : process.env.STRIPE_SECRET_KEY;

      if (stripeSecretKey && voucher.reserved_session_id) {
        const existingSession = await getStripeCheckoutSession(
          stripeSecretKey,
          voucher.reserved_session_id
        );

        if (
          existingSession?.payment_status === "paid" ||
          existingSession?.status === "complete"
        ) {
          return res.status(409).json({
            error: "Die Zahlung mit diesem Gutschein wird gerade verarbeitet."
          });
        }

        if (existingSession?.status === "open" && existingSession?.url) {
          const requestItems = Array.isArray(req.body?.items) ? req.body.items : [];
          const requestIds = requestItems
            .map(item => String(item?.id || ""))
            .filter(Boolean);

          const sameProducts =
            !requestIds.length ||
            existingSession?.metadata?.dragemor_product_ids === requestIds.join(",");

          if (sameProducts) {
            return res.status(200).json({
              valid: true,
              code: voucher.code,
              balance: Number(voucher.balance),
              initialValue: Number(voucher.initial_value),
              reserved: true,
              checkoutUrl: existingSession.url
            });
          }

          // Der Warenkorb wurde seit dem letzten Stripe-Aufruf verändert.
          // Die alte Stripe-Session darf dann nicht mehr geöffnet werden.
          await expireStripeCheckoutSession(
            stripeSecretKey,
            voucher.reserved_session_id
          );
          await releaseVoucherReservation(sql, voucher.reservation_token);
        } else if (existingSession?.status === "expired") {
          await releaseVoucherReservation(sql, voucher.reservation_token);
        } else {
          return res.status(409).json({
            error: "Der vorherige Bezahlvorgang konnte gerade nicht geprüft werden. Bitte versuche es gleich noch einmal."
          });
        }
      } else {
        return res.status(409).json({
          error: "Dieser Gutschein wird gerade in einem anderen Bezahlvorgang verwendet."
        });
      }
    }

    return res.status(200).json({
      valid: true,
      code: voucher.code,
      balance: Number(voucher.balance),
      initialValue: Number(voucher.initial_value)
    });
  }

  if (action === "release-voucher") {
    const token = String(req.body?.reservationToken || "").trim();
    if (token && token.length <= 120) {
      await releaseVoucherReservation(sql, token);
    }
    return res.status(200).json({ ok: true });
  }

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length || items.length > 20) {
    return res.status(400).json({
      error: !items.length ? "Der Warenkorb ist leer." : "Zu viele Artikel im Warenkorb."
    });
  }

  const ids = items.map(item => String(item?.id || ""));
  if (
    ids.some(id => !id || id.length > 120) ||
    new Set(ids).size !== ids.length ||
    ids.some(id => retiredLegacyIds.has(id))
  ) {
    return res.status(400).json({
      error: "Ein Artikel ist nicht mehr bestellbar oder der Warenkorb ist ungültig."
    });
  }

  const isPreview = process.env.VERCEL_ENV === "preview";
  const stripeSecretKey = isPreview
    ? process.env.STRIPE_TEST_SECRET_KEY
    : process.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    return res.status(500).json({ error: "Stripe ist noch nicht vollständig eingerichtet." });
  }

  let selected = [];

  try {
    const deletedTable = await sql`SELECT to_regclass('public.deleted_products') AS relation`;
    if (deletedTable[0]?.relation) {
      const removed = await sql`
        SELECT product_id FROM deleted_products WHERE product_id = ANY(${ids})
      `;
      if (removed.length) {
        return res.status(409).json({
          error: "Mindestens ein Artikel wurde aus dem Sortiment genommen."
        });
      }
    }

    const rows = await sql`
      SELECT product_id, name, price, status
      FROM products WHERE product_id = ANY(${ids})
    `;
    const productsById = new Map(rows.map(row => [row.product_id, row]));

    for (const id of ids) {
      const dbProduct = productsById.get(id);
      if (!dbProduct) {
        return res.status(409).json({
          error: "Mindestens ein Artikel ist nicht mehr verfügbar."
        });
      }

      if (dbProduct.status !== "available") {
        return res.status(409).json({
          error: "Mindestens ein Artikel wurde leider bereits verkauft."
        });
      }

      const amount = Number(dbProduct.price);
      if (
        typeof dbProduct.name !== "string" ||
        !dbProduct.name.trim() ||
        !Number.isInteger(amount) ||
        amount <= 0
      ) {
        return res.status(409).json({
          error: "Produktdaten sind unvollständig. Bitte überprüfe den Artikel."
        });
      }

      selected.push({ id, product: { name: dbProduct.name, amount } });
    }
  } catch (error) {
    console.error("Bestandsprüfung fehlgeschlagen:", error);
    return res.status(500).json({ error: "Der Warenbestand konnte nicht geprüft werden." });
  }

  const subtotal = selected.reduce((sum, item) => sum + item.product.amount, 0);
  const voucherInput = String(req.body?.voucherCode || "").trim();
  let voucherReservation = null;

  if (voucherInput) {
    try {
      const voucher = await findVoucher(sql, voucherInput);

      if (!voucher) {
        return res.status(404).json({ error: "Dieser Gutscheincode wurde nicht gefunden." });
      }
      if (voucher.status === "prepared") {
        return res.status(409).json({ error: "Dieser Gutschein wurde noch nicht aktiviert." });
      }
      if (voucher.status === "redeemed" || Number(voucher.balance) <= 0) {
        return res.status(409).json({ error: "Dieser Gutschein wurde bereits vollständig eingelöst." });
      }
      if (voucher.status !== "active") {
        return res.status(409).json({ error: "Dieser Gutschein ist momentan nicht einlösbar." });
      }

      const discount = Math.min(Number(voucher.balance), subtotal);
      if (!Number.isInteger(discount) || discount <= 0) {
        return res.status(409).json({ error: "Für diesen Gutschein ist kein Guthaben mehr verfügbar." });
      }

      // Wurde für genau diesen Warenkorb bereits eine Stripe-Session erstellt,
      // geben wir deren URL erneut zurück. So lässt sich ein unterbrochener
      // Weiterleitungsversuch sofort fortsetzen, ohne eine zweite Reservierung.
      if (
        voucher.reservation_token &&
        voucher.reserved_session_id &&
        voucher.reserved_until &&
        new Date(voucher.reserved_until).getTime() > Date.now()
      ) {
        const existingSession = await getStripeCheckoutSession(
          stripeSecretKey,
          voucher.reserved_session_id
        );

        const sameProducts =
          existingSession?.metadata?.dragemor_product_ids === ids.join(",");

        if (
          existingSession?.status === "open" &&
          existingSession?.url &&
          sameProducts
        ) {
          return res.status(200).json({
            url: existingSession.url,
            reused: true
          });
        }

        if (
          existingSession?.payment_status === "paid" ||
          existingSession?.status === "complete"
        ) {
          return res.status(409).json({
            error: "Die Zahlung mit diesem Gutschein wird gerade verarbeitet."
          });
        }

        if (existingSession?.status === "open" && !sameProducts) {
          // Warenkorb geändert: alte Stripe-Session schließen und die
          // Gutscheinreservierung sofort für den neuen Warenkorb freigeben.
          await expireStripeCheckoutSession(
            stripeSecretKey,
            voucher.reserved_session_id
          );
          await releaseVoucherReservation(sql, voucher.reservation_token);
        } else if (existingSession?.status === "expired") {
          await releaseVoucherReservation(sql, voucher.reservation_token);
        } else if (!existingSession) {
          return res.status(409).json({
            error: "Der vorherige Bezahlvorgang konnte gerade nicht geprüft werden. Bitte versuche es gleich noch einmal."
          });
        }
      }

      const reservationToken = crypto.randomUUID();
      const reserved = await sql`
        UPDATE vouchers
        SET
          reserved_amount = ${discount},
          reservation_token = ${reservationToken},
          reserved_session_id = NULL,
          reserved_until = NOW() + INTERVAL '35 minutes',
          updated_at = NOW()
        WHERE code = ${voucher.code}
          AND status = 'active'
          AND balance >= ${discount}
          AND (
            reservation_token IS NULL OR
            reserved_until IS NULL OR
            reserved_until < NOW()
          )
        RETURNING code, balance, reserved_amount, reservation_token
      `;

      if (!reserved.length) {
        return res.status(409).json({
          error: "Dieser Gutschein wird gerade in einem anderen Bezahlvorgang verwendet. Bitte versuche es später erneut."
        });
      }

      voucherReservation = {
        code: voucher.code,
        discount,
        token: reservationToken
      };
    } catch (error) {
      console.error("Gutscheinprüfung fehlgeschlagen:", error);
      return res.status(500).json({ error: "Der Gutschein konnte nicht geprüft werden." });
    }
  }

  let stripeCouponId = null;

  try {
    if (voucherReservation) {
      stripeCouponId = await createStripeCoupon(stripeSecretKey, voucherReservation);
    }

    const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;
    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("success_url", `${origin}/?checkout=success#shop`);

    const cancelQuery = new URLSearchParams({ checkout: "cancel" });
    if (voucherReservation?.token) {
      cancelQuery.set("voucherReservation", voucherReservation.token);
      params.set("expires_at", String(Math.floor(Date.now() / 1000) + 31 * 60));
    }
    params.set("cancel_url", `${origin}/?${cancelQuery.toString()}#shop`);

    params.set("billing_address_collection", "auto");
    params.set("shipping_address_collection[allowed_countries][0]", "DE");
    params.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
    params.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", "699");
    params.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "eur");
    params.set("shipping_options[0][shipping_rate_data][display_name]", "DHL Paket – versicherter Versand");
    params.set("customer_creation", "always");
    // WICHTIG: Stripe erlaubt `allow_promotion_codes` und `discounts`
    // nicht gleichzeitig – auch nicht mit `allow_promotion_codes=false`.
    // Ohne Gutschein ist der Parameter unnötig, weil false ohnehin Standard ist.
    params.set("metadata[dragemor_product_ids]", selected.map(({ id }) => id).join(","));

    if (voucherReservation) {
      params.set("discounts[0][coupon]", stripeCouponId);
      params.set("metadata[dragemor_voucher_code]", voucherReservation.code);
      params.set("metadata[dragemor_voucher_amount]", String(voucherReservation.discount));
      params.set("metadata[dragemor_voucher_reservation]", voucherReservation.token);
    }

    selected.forEach(({ id, product }, i) => {
      params.set(`line_items[${i}][quantity]`, "1");
      params.set(`line_items[${i}][price_data][currency]`, "eur");
      params.set(`line_items[${i}][price_data][unit_amount]`, String(product.amount));
      params.set(`line_items[${i}][price_data][product_data][name]`, product.name);
      params.set(`line_items[${i}][price_data][product_data][metadata][dragemor_product_id]`, id);
    });

    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const data = await response.json();

    if (!response.ok || !data?.url) {
      if (voucherReservation) {
        await releaseVoucherReservation(sql, voucherReservation.token);
      }
      console.error("Stripe:", data);
      return res.status(502).json({
        error: data?.error?.message || "Stripe Checkout konnte nicht erstellt werden."
      });
    }

    if (voucherReservation) {
      await sql`
        UPDATE vouchers
        SET reserved_session_id = ${data.id}, updated_at = NOW()
        WHERE reservation_token = ${voucherReservation.token}
      `;
    }

    return res.status(200).json({ url: data.url });
  } catch (error) {
    if (voucherReservation) {
      try {
        await releaseVoucherReservation(sql, voucherReservation.token);
      } catch (releaseError) {
        console.error("Gutscheinreservierung konnte nicht freigegeben werden:", releaseError);
      }
    }

    console.error("Stripe Checkout Fehler:", error);
    return res.status(500).json({
      error: error?.message || "Verbindung zu Stripe fehlgeschlagen."
    });
  }
}
