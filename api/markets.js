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
        info,
        COALESCE(end_date, market_date) < (NOW() AT TIME ZONE 'Europe/Berlin')::date AS is_past
      FROM markets
      ORDER BY market_date ASC, id ASC
    `;

    const upcoming = [];
    const pastMarkets = [];
    for (const { is_past, ...market } of markets) {
      if (is_past) {
        const { id, name, market_date, end_date, location } = market;
        pastMarkets.push({ id, name, market_date, end_date, location });
      } else {
        upcoming.push(market);
      }
    }
    return res.status(200).json({ markets: upcoming, pastMarkets: pastMarkets.reverse() });

  } catch (error) {
    console.error("Öffentliche Markt-Termine Fehler:", error);

    return res.status(500).json({
      error: "Markt-Termine konnten nicht geladen werden."
    });
  }
} 
