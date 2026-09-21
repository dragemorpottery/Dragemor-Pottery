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
  "keramik-17": { name: "Erdtanz", amount: 1800 },
  "keramik-18": { name: "Meeresgrund", amount: 1800 },
  "keramik-19": { name: "des Drachens Wasser", amount: 1800 },
  "keramik-20": { name: "des Drachens Wasser", amount: 1800 },
  "keramik-21": { name: "des Drachens Wasser", amount: 1800 },
  "keramik-22": { name: "des Drachens Wasser", amount: 1500 },
  "weihnachten-feuerlicht": { name: "Feuerlicht – Teelichthalter", amount: 500 }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  const isPreview = process.env.VERCEL_ENV === 'preview';

const stripeSecretKey = isPreview
  ? process.env.STRIPE_TEST_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  return res.status(500).json({
    error: 'Stripe ist noch nicht vollständig eingerichtet.'
  });
} 
  
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Der Warenkorb ist leer.' });
  if (items.length > 20) return res.status(400).json({ error: 'Zu viele Artikel im Warenkorb.' });

  const selected = items.map(item => ({ id: String(item.id || ''), product: catalog[String(item.id || '')] }));
  if (selected.some(x => !x.product)) return res.status(400).json({ error: 'Mindestens ein Artikel kann derzeit nicht bezahlt werden.' });
   const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return res.status(500).json({
      error: 'Datenbank ist noch nicht vollständig eingerichtet.'
    });
  }

  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(databaseUrl);

    const productIds = selected.map(({ id }) => id);

    const unavailableProducts = await sql`
      SELECT product_id
      FROM products
      WHERE product_id = ANY(${productIds})
        AND status <> 'available'
    `;

    if (unavailableProducts.length > 0) {
      return res.status(409).json({
        error: 'Mindestens ein Artikel wurde leider bereits verkauft.'
      });
    }
  } catch (error) {
    console.error('Bestandsprüfung fehlgeschlagen:', error);

    return res.status(500).json({
      error: 'Der Warenbestand konnte nicht geprüft werden.'
    });
  } 

  const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', `${origin}/?checkout=success#shop`);
  params.set('cancel_url', `${origin}/?checkout=cancel#shop`);
  params.set('billing_address_collection', 'auto');
  params.set('shipping_address_collection[allowed_countries][0]', 'DE');
  

  
params.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
params.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]', '699');
params.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'eur');
params.set('shipping_options[0][shipping_rate_data][display_name]', 'DHL Paket – versicherter Versand'); 
  params.set('customer_creation', 'always');
  params.set('allow_promotion_codes', 'false');
  params.set(
  'metadata[dragemor_product_ids]',
  selected.map(({ id }) => id).join(',')
);

  selected.forEach(({id, product}, i) => {
    params.set(`line_items[${i}][quantity]`, '1');
    params.set(`line_items[${i}][price_data][currency]`, 'eur');
    params.set(`line_items[${i}][price_data][unit_amount]`, String(product.amount));
    params.set(`line_items[${i}][price_data][product_data][name]`, product.name);
    params.set(`line_items[${i}][price_data][product_data][metadata][dragemor_product_id]`, id);
  });

  try {
    const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await stripeResponse.json();
    if (!stripeResponse.ok) {
      console.error('Stripe:', data);
      return res.status(502).json({ error: data?.error?.message || 'Stripe Checkout konnte nicht erstellt werden.' });
    }
    return res.status(200).json({ url: data.url });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Verbindung zu Stripe fehlgeschlagen.' });
  }
}
