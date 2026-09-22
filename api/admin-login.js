import crypto from "crypto";

function createToken() {
  return crypto
    .createHmac("sha256", process.env.ADMIN_PASSWORD)
    .update("dragemor-admin")
    .digest("hex");
}

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      message: "Methode nicht erlaubt."
    });
  }

  const { password } = req.body || {};

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({
      ok: false,
      message: "Admin-Passwort ist noch nicht eingerichtet."
    });
  }

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      ok: false,
      message: "Passwort ist nicht korrekt."
    });
  }

  const token = createToken();

  res.setHeader(
    "Set-Cookie",
    `dragemor_admin=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`
  );

  return res.status(200).json({
    ok: true
  });
} 
