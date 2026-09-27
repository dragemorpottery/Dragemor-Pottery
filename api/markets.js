export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Methode nicht erlaubt."
    });
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return res.status(500).json({
      error: "Datenbank ist nicht eingerichtet."
    });
  }

  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl);

    const markets = await sql`
      SELECT
        id,
        name,
        market_date,
        end_date,
        time_text,
        location,
        info
      FROM markets
      WHERE COALESCE(end_date, market_date) >= CURRENT_DATE
      ORDER BY market_date ASC
    `;

    return res.status(200).json({
      markets
    });

  } catch (error) {
    console.error("Öffentliche Markt-Termine Fehler:", error);

    return res.status(500).json({
      error: "Markt-Termine konnten nicht geladen werden."
    });
  }
} 
