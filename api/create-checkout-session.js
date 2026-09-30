// The original legacy catalog is retained for items which have NEVER been
// managed in Neon. A formerly managed item must have an active DB row.
const catalog = {
  "keramik-1": { name: "WaterDragon", amount: 1800 },
  "keramik-2": { name: "WaterDragon", amount: 1800 },
  "keramik-3": { name: "Erdtanz", amount: 1800 },
  "keramik-4": { name: "WaterDragon", amount: 1500 },
  "keramik-5": { name: "Waldritual – Keramikset", amount: 3500 },
  "keramik-6": { name: "Nebelwald", amount: 1500 },
  "keramik-8": { name: "Erdtanz", amount: 1500 },
  "keramik-9": { name: "Erdtanz", amount: 1900 },
  "keramik-10": { name: "Erdtanz", amount: 1500 },
  "keramik-11": { name: "WaterDragon", amount: 1000 },
  "keramik-12": { name: "des Drachens Wasser", amount: 1900 },
  "keramik-13": { name: "DragonGold", amount: 1500 },
  "keramik-14": { name: "Waldgeflüster – Set", amount: 1500 },
  "keramik-15": { name: "Dämmerwald", amount: 1000 },
  "keramik-16": { name: "Feuerlicht – Teelichthalter", amount: 500 },
  "keramik-18": { name: "Meeresgrund", amount: 1800 },
  "keramik-19": { name: "des Drachens Wasser", amount: 1800 },
  "keramik-20": { name: "des Drachens Wasser", amount: 1800 },
  "keramik-21": { name: "des Drachens Wasser", amount: 1800 },
  "keramik-22": { name: "des Drachens Wasser", amount: 1500 },
  "weihnachten-feuerlicht": { name: "Feuerlicht – Teelichthalter", amount: 500 }
};

// Historical IDs already managed in the central product database.
const managedLegacyIds = new Set([
  "keramik-1", "keramik-4", "keramik-7", "keramik-9", "keramik-12",
  "keramik-14", "keramik-22", "keramik-24", "keramik-26", "keramik-29",
  "keramik-30", "keramik-33", "keramik-37", "keramik-40",
  "keramik-49", "keramik-53", "keramik-56", "keramik-58",
  ...Array.from({ length: 12 }, (_, i) => `leder-${i + 1}`)
]);
// Only this current, unmanaged legacy listing may use the static fallback.
// Older historical IDs must not be orderable from an old saved cart.
const legacyFallbackIds = new Set(["weihnachten-feuerlicht"]);
const retiredLegacyIds = new Set([
  "keramik-17", "keramik-017", "keramik-29", "keramik-029",
  "keramik-37", "keramik-037", "keramik-55", "keramik-055"
]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Methode nicht erlaubt." });
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length || items.length > 20) {
    return res.status(400).json({ error: !items.length ? "Der Warenkorb ist leer." : "Zu viele Artikel im Warenkorb." });
  }
  const ids = items.map(item => String(item?.id || ""));
  if (ids.some(id => !id || id.length > 120) || new Set(ids).size !== ids.length ||
      ids.some(id => retiredLegacyIds.has(id))) {
    return res.status(400).json({ error: "Ein Artikel ist nicht mehr bestellbar oder der Warenkorb ist ungültig." });
  }

  const isPreview = process.env.VERCEL_ENV === "preview";
  const stripeSecretKey = isPreview
    ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return res.status(500).json({ error: "Stripe ist noch nicht vollständig eingerichtet." });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: "Datenbank ist noch nicht vollständig eingerichtet." });
  }

  let selected;
  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(process.env.DATABASE_URL);
    const deletedTable = await sql`SELECT to_regclass('public.deleted_products') AS relation`;
    if (deletedTable[0]?.relation) {
      const removed = await sql`
        SELECT product_id FROM deleted_products WHERE product_id = ANY(${ids})
      `;
      if (removed.length) return res.status(409).json({
        error: "Mindestens ein Artikel wurde aus dem Sortiment genommen."
      });
    }

    const rows = await sql`
      SELECT product_id, name, price, status
      FROM products WHERE product_id = ANY(${ids})
    `;
    const productsById = new Map(rows.map(row => [row.product_id, row]));
    selected = [];
    for (const id of ids) {
      const dbProduct = productsById.get(id);
      if (!dbProduct) {
        // After deletion a managed item must never fall back to an old
        // catalog price/name (even if that static ID is still known).
        if (managedLegacyIds.has(id) || !catalog[id] || !legacyFallbackIds.has(id)) {
          return res.status(409).json({
            error: "Mindestens ein Artikel ist nicht mehr in der Produktverwaltung vorhanden."
          });
        }
        selected.push({ id, product: catalog[id] });
        continue;
      }
      if (dbProduct.status !== "available") {
        return res.status(409).json({ error: "Mindestens ein Artikel wurde leider bereits verkauft." });
      }
      const amount = Number(dbProduct.price);
      if (typeof dbProduct.name !== "string" || !dbProduct.name.trim() ||
          !Number.isInteger(amount) || amount <= 0) {
        return res.status(409).json({ error: "Produktdaten sind unvollständig. Bitte überprüfe den Artikel." });
      }
      selected.push({ id, product: { name: dbProduct.name, amount } });
    }
  } catch (error) {
    console.error("Bestandsprüfung fehlgeschlagen:", error);
    return res.status(500).json({ error: "Der Warenbestand konnte nicht geprüft werden." });
  }

  const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", `${origin}/?checkout=success#shop`);
  params.set("cancel_url", `${origin}/?checkout=cancel#shop`);
  params.set("billing_address_collection", "auto");
  params.set("shipping_address_collection[allowed_countries][0]", "DE");
  params.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
  params.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", "699");
  params.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "eur");
  params.set("shipping_options[0][shipping_rate_data][display_name]", "DHL Paket – versicherter Versand");
  params.set("customer_creation", "always");
  params.set("allow_promotion_codes", "false");
  params.set("metadata[dragemor_product_ids]", selected.map(({ id }) => id).join(","));
  selected.forEach(({ id, product }, i) => {
    params.set(`line_items[${i}][quantity]`, "1");
    params.set(`line_items[${i}][price_data][currency]`, "eur");
    params.set(`line_items[${i}][price_data][unit_amount]`, String(product.amount));
    params.set(`line_items[${i}][price_data][product_data][name]`, product.name);
    params.set(`line_items[${i}][price_data][product_data][metadata][dragemor_product_id]`, id);
  });

  try {
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Stripe:", data);
      return res.status(502).json({ error: data?.error?.message || "Stripe Checkout konnte nicht erstellt werden." });
    }
    return res.status(200).json({ url: data.url });
  } catch (error) {
    console.error("Stripe Checkout Fehler:", error);
    return res.status(500).json({ error: "Verbindung zu Stripe fehlgeschlagen." });
  }
}
