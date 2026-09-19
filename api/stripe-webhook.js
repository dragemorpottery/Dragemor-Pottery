export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  }

  const event = req.body;

  if (event?.type === 'checkout.session.completed') {
    const session = event.data?.object;

    console.log('Neue bezahlte Bestellung:', {
      sessionId: session?.id,
      paymentStatus: session?.payment_status,
      customerEmail: session?.customer_details?.email,
      amountTotal: session?.amount_total
    });
  }

  return res.status(200).json({ received: true });
}
