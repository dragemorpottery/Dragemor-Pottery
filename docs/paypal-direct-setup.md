# Direkte PayPal-Zahlung für Dragemor Pottery

Die Anbindung verwendet PayPal Checkout direkt und benötigt keine Freischaltung von PayPal in Stripe. Der Button bleibt ohne vollständige Konfiguration unsichtbar. Die Änderungen sind vor der Produktivfreigabe mit einem echten PayPal-Sandbox-Käufer zu prüfen.

## 1. PayPal-App und Rückmeldung einrichten

Im [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications/live) unter **Apps & Credentials** eine Händler-App für Dragemor Pottery erstellen. Client-ID und Secret gehören zu dieser direkten App, nicht zur ausstehenden Stripe-Verknüpfung. Die Händler-ID steht im PayPal-Geschäftskonto unter Geschäftsinformationen.

Für dieselbe App einen Webhook einrichten:

```
https://dragemor-pottery.de/api/stripe-webhook?provider=paypal
```

Der historische URL-Name wird beibehalten, um keine weitere Vercel-Funktion zu benötigen. Die Nachricht wird ausschließlich mit PayPal geprüft, unabhängig von Stripe-Schlüsseln. Diese Ereignisse auswählen:

- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.PENDING`
- `PAYMENT.CAPTURE.DENIED`

Die zurückgegebene Webhook-ID ebenfalls hinterlegen. Ein Webhook muss ohne interaktive Anmeldung erreichbar sein.

## 2. Zugangsdaten sicher in Vercel hinterlegen

| Variable | Inhalt |
| --- | --- |
| `PAYPAL_CLIENT_ID` | Client-ID der Live-App |
| `PAYPAL_CLIENT_SECRET` | Secret der Live-App, ausschließlich serverseitig |
| `PAYPAL_MERCHANT_ID` | Händler-ID des empfangenden Geschäftskontos |
| `PAYPAL_WEBHOOK_ID` | ID des Webhooks der Live-App |
| `PAYPAL_ENABLED` | Erst nach erfolgreichem Test auf `true` setzen |

Die vorhandenen `DATABASE_URL`, `RESEND_API_KEY`, `INVOICE_TAX_NUMBER` und `ORDER_NOTIFICATION_EMAIL` werden weiterverwendet. Secrets nicht in Chat, Screenshots, Git oder öffentliches HTML kopieren. Nach geänderten Vercel-Variablen neu bereitstellen. Beim ersten Start der gemeinsamen Bestandssperre beginnt produktiv eine automatische **24-Stunden-Übergangszeit**. Solange bleibt PayPal ausgeblendet, damit alte, noch nicht erfasste Stripe-Kassen auslaufen können. Sandbox-Tests sind sofort möglich.

Für Sandbox/Preview heißen die vier PayPal-Zugangsdaten `PAYPAL_TEST_CLIENT_ID`, `PAYPAL_TEST_CLIENT_SECRET`, `PAYPAL_TEST_MERCHANT_ID`, `PAYPAL_TEST_WEBHOOK_ID`. Zusätzlich ist `PAYPAL_TEST_DATABASE_URL` zu einer **separaten Neon-Testdatenbank mit bestehendem Shop-Schema** erforderlich. Für den Testzweig muss zusätzlich `DATABASE_URL` als branch-spezifische Preview-Variable auf dieselbe separate Testdatenbank zeigen, damit auch Katalog, Gutscheinprüfung und andere Shop-Endpunkte isoliert bleiben. Preview greift niemals auf Live-PayPal-Zugangsdaten zurück. Der Sandbox-Webhook verwendet die feste Branch-Preview-URL mit `/api/stripe-webhook?provider=paypal`. Außerhalb eines Vercel-Previews aktiviert `PAYPAL_ENV=sandbox` denselben Testmodus. Keine produktive Datenbank als Testdatenbank eintragen. Die in Testbestellungen verwendeten E-Mail-Adressen müssen eigene kontrollierte Testadressen sein.

## 3. Vor Freischaltung prüfen

1. Sandbox-App und -Webhook mit öffentlich erreichbarer Test-URL einrichten; keine echten Kundenartikel verwenden.
2. Test mit und ohne Gutschein: Datenbankpreise und 6,99 € Versand stimmen; nur deutsche Lieferadressen werden vor der Abbuchung akzeptiert.
3. Zahlung bestätigen: Bestand wird zentral `sold`, derselbe Artikel ist im Marktbegleiter nicht mehr verfügbar. Die bestätigte PayPal-Rückmeldung erstellt eine Rechnung im bestehenden Nummernkreis und verschickt interne Nachricht, Bestellbestätigung und Rechnungs-PDF.
4. PayPal-Fenster abbrechen: Warenkorb und Gutschein bleiben erhalten. Wiederholte Rückmeldungen verbuchen den Gutschein nicht erneut und versenden abgeschlossene E-Mail-Schritte nicht erneut.
5. Preis/Bestand zwischen Öffnen und Bestätigen ändern: PayPal darf anschließend keine neue Abbuchung starten.
6. Mobilgerät, Popup, Rückkehr aus der PayPal-App und Browser-Neuladen prüfen. Ungeklärte Zahlungen lassen sich im selben Browser-Tab über „Zahlung fortsetzen / Status prüfen“ wieder aufnehmen.
7. Danach Live-Zugangsdaten konfigurieren, veröffentlichen und eine ausdrücklich autorisierte kleine Live-Testbestellung einschließlich Webhook, E-Mails und Rechnung prüfen.

## Betriebsdetails und Grenzen

- Der SDK wird erst auf ausdrückliche Auswahl von PayPal geladen. Der öffentliche Konfigurationsaufruf gibt nur Freigabestatus und Client-ID zurück.
- Produktpreise, Versionen, Gutschein und Bestand werden serverseitig geprüft. Vor dem Capture werden alle Produkte und der Gutschein in einer atomaren SQL-Anweisung verbucht. Andere Marktverkäufe sehen ab diesem Zeitpunkt `sold`.
- Bei unklarem Capture-Ausgang bleibt der Bestand gesperrt. Ein zweiter Versuch verwendet dieselbe PayPal-Idempotenzkennung. Nur eine endgültig abgelehnte, bei PayPal erneut geprüfte Zahlung gibt noch unveränderten Bestand und Gutschein automatisch frei. Bei API-Fehlern ohne endgültiges Capture-Ergebnis ist eine Prüfung der Bestellung nötig; niemals blind wieder auf verfügbar setzen.
- Rechnungen und E-Mails werden durch den verifizierten Webhook verarbeitet. Fehlgeschlagene Schritte bleiben gespeichert und führen zur erneuten Webhook-Zustellung. PDF-Anhang und E-Mail-Idempotenzkennungen bleiben bei Wiederholungen gleich. Resend-Idempotenz ist zeitlich begrenzt; bei längeren Störungen die protokollierten Sendeschritte prüfen.
- Neue Stripe-Kassen reservieren die Artikel zentral für Stripe, PayPal und den Marktbegleiter. Sie laufen nach 31 Minuten ab. Die Stripe-Ereignisse `checkout.session.expired` und `checkout.session.async_payment_failed` sollten am vorhandenen Stripe-Webhook aktiviert sein. Zusätzlich werden ältere Sperren anhand des tatsächlichen Stripe-Status geprüft und ausschließlich bei bestätigt abgelaufenen, unbezahlten Kassen freigegeben. Ein verlorenes API-Ergebnis ohne gespeicherte Session-ID benötigt eine gezielte Prüfung; eine reine Zeitüberschreitung gibt den Bestand nicht blind frei. Die 24-stündige Übergangszeit schützt vor alten Stripe-Sessions, die vor diesem Update erstellt wurden.
- Erstattungen erfolgen in PayPal; sie stellen einen Artikel nicht automatisch wieder auf verfügbar. Die bewusste Wiederfreigabe erfolgt in der Verwaltung.

## Automatisierte Prüfung

```
npm ci
npm test
```

Die PayPal-API und E-Mail-Zustellung sind in den Tests ersetzt; SQL-Buchungen laufen gegen eine echte lokale PostgreSQL-Engine (PGlite). Diese Prüfung ersetzt weder einen Sandbox-Test mit PayPal noch den Live-Test.

Referenzen: [PayPal Checkout](https://developer.paypal.com/studio/checkout/standard/integrate), [PayPal Webhooks](https://developer.paypal.com/api/rest/webhooks/rest/).
