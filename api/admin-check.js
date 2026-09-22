import crypto from "crypto";

function createToken() {
  return crypto
    .createHmac("sha256", process.env.ADMIN_PASSWORD)
    .update("dragemor-admin")
    .digest("hex");
}

export default function handler(req, res) {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({
      authenticated: false
    });
  }

  const cookies = req.headers.cookie || "";

  const adminCookie = cookies
    .split(";")
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith("dragemor_admin="));

  if (!adminCookie) {
    return res.status(401).json({
      authenticated: false
    });
  }

  const token = adminCookie.substring(
    "dragemor_admin=".length
  );

  const expectedToken = createToken();

  if (token !== expectedToken) {
    return res.status(401).json({
      authenticated: false
    });
  }

  return res.status(200).json({
    authenticated: true
  });
} 
