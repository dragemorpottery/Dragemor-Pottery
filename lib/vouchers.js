export async function ensureVoucherTables(sql) {
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

