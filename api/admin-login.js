export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
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

  return res.status(200).json({
    ok: true
  });
} 
