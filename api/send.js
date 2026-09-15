export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Methode nicht erlaubt"
    });
  }

  try {
    const { name, email, betreff, nachricht } = req.body;

    if (!name || !email || !nachricht) {
      return res.status(400).json({
        error: "Bitte alle Pflichtfelder ausfüllen."
      });
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: "Dragmor Pottery 
          <kontakt@dragemor-pottery.de>",
        to: ["afspring23@gmail.com"],
        reply_to: email,
        subject: betreff || "Neue Nachricht über Dragemor Pottery",
        text:
          `Neue Nachricht über die Website\n\n` +
          `Name: ${name}\n` +
          `E-Mail: ${email}\n` +
          `Betreff: ${betreff || "-"}\n\n` +
          `Nachricht:\n${nachricht}`
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Resend Fehler:", data);

      return res.status(500).json({
        error: data.message || "Die Nachricht konnte nicht gesendet werden."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Nachricht erfolgreich gesendet."
    });

  } catch (error) {
    console.error("Serverfehler:", error);

    return res.status(500).json({
      error: "Serverfehler beim Senden der Nachricht."
    });
  }
}

