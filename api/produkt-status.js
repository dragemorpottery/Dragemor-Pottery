export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Methode nicht erlaubt.'
    });
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return res.status(500).json({
      error: 'Datenbank ist noch nicht vollständig eingerichtet.'
    });
  }

  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(databaseUrl);

    const products = await sql`
      SELECT product_id, status
      FROM products
    `;

    const productStatus = {};

    for (const product of products) {
      productStatus[product.product_id] = product.status;
    }

    return res.status(200).json(productStatus);

  } catch (error) {
    console.error('Produktstatus konnte nicht geladen werden:', error);

    return res.status(500).json({
      error: 'Produktstatus konnte nicht geladen werden.'
    });
  }
} 
