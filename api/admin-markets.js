import crypto from "crypto";

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

  const token = adminCookie.substring(
    "dragemor_admin=".length
  );

  return token === createToken();
}

export default async function handler(req, res) {
  if (!isAdmin(req)) {
    return res.status(401).json({
      error: "Nicht angemeldet."
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

    await sql`
      CREATE TABLE IF NOT EXISTS markets (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        market_date DATE NOT NULL,
        end_date DATE,
        time_text TEXT,
        location TEXT NOT NULL,
        info TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await sql`
  ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS end_date DATE
`; 

    if (req.method === "GET") {
      const markets = await sql`
        SELECT
          id,
          name,
          market_date,
          end_date,
          time_text,
          location,
          info,
          created_at,
          updated_at
        FROM markets
        ORDER BY market_date ASC
      `;

      return res.status(200).json({
        markets
      });
    }

    if (req.method === "POST") {
      const {
        name,
        market_date,
        end_date,
        time_text,
        location,
        info
      } = req.body || {};

      if (!name || !market_date || !location) {
        return res.status(400).json({
          error: "Bitte Marktname, Datum und Ort ausfüllen."
        });
      }

      const created = await sql`
        INSERT INTO markets (
          name,
          market_date,
          end_date,
          time_text,
          location,
          info
        )
        VALUES (
          ${name},
          ${market_date},
          ${end_date|| null},
          ${time_text || null},
          ${location},
          ${info || null}
        )
        RETURNING *
      `;

      return res.status(201).json({
        ok: true,
        market: created[0]
      });
    }

    return res.status(405).json({
      error: "Methode nicht erlaubt."
    });

  } catch (error) {
    console.error("Marktverwaltung Fehler:", error);

    return res.status(500).json({
      error: "Markt-Daten konnten nicht verarbeitet werden."
    });
  }
} 
