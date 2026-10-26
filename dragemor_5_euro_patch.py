#!/usr/bin/env python3
"""Ergänzt das bestehende Dragemor-Pottery-Gutscheinsystem um 5-Euro-Gutscheine.

Verwendung: Im Stammverzeichnis des Repositories ausführen:
    python3 dragemor_5_euro_patch.py

Optional: Nur prüfen, ohne Dateien zu verändern:
    python3 dragemor_5_euro_patch.py --check
"""
from pathlib import Path
import sys

ROOT = Path.cwd()
BACKEND = ROOT / 'api' / 'admin-products.js'
FRONTEND = ROOT / 'admin.html'


def replace_once(content: str, old: str, new: str, what: str) -> str:
    if content.count(old) != 1:
        raise ValueError(f'{what}: erwartete Textstelle wurde nicht genau einmal gefunden (gefunden: {content.count(old)}). Keine Dateien verändert.')
    return content.replace(old, new, 1)


def main() -> None:
    if not BACKEND.is_file() or not FRONTEND.is_file():
        raise SystemExit('Bitte im Hauptordner von Dragemor-Pottery ausführen (api/admin-products.js und admin.html erforderlich).')

    backend_original = BACKEND.read_text(encoding='utf-8')
    frontend_original = FRONTEND.read_text(encoding='utf-8')

    if 'create-five-euro-voucher' in backend_original or 'erstelleFuenfEuroGutschein' in frontend_original:
        raise SystemExit('Die 5-Euro-Gutschein-Erweiterung scheint schon installiert zu sein. Keine Dateien verändert.')

    backend_needle = '    if (req.method === "POST" && req.body?.action === "activate-voucher") {'
    backend_insert = '''    // Individuelle 5-Euro-Gutscheine: Codes werden ausschließlich serverseitig erzeugt.
    if (req.method === "POST" && req.body?.action === "create-five-euro-voucher") {
      await seedPreparedVouchers(sql);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const randomPart = crypto.randomBytes(9).toString("hex").toUpperCase();
        const code = `DRG-${randomPart.slice(0, 6)}-${randomPart.slice(6, 12)}-${randomPart.slice(12)}-05`;

        const created = await sql`
          INSERT INTO vouchers (code, initial_value, balance, status, source)
          VALUES (${code}, 500, 500, 'prepared', 'market')
          ON CONFLICT (code) DO NOTHING
          RETURNING code, initial_value, balance, status
        `;

        if (created.length) {
          return res.status(201).json({ ok: true, voucher: created[0] });
        }
      }

      return res.status(503).json({ error: "Ein neuer Gutscheincode konnte nicht erzeugt werden." });
    }

'''
    backend_updated = replace_once(backend_original, backend_needle, backend_insert + backend_needle, 'Gutschein-API')

    description_old = '''        15 vorbereitete Papiergutscheine: 5 × 15 €, 5 × 25 € und 5 × 50 €.
        Erst nach der Aktivierung beim Verkauf kann der Code im Onlineshop eingelöst werden.'''
    description_new = '''        15 vorbereitete Papiergutscheine: 5 × 15 €, 5 × 25 € und 5 × 50 €.
        Weitere Gutscheine über 5 € kannst du hier erstellen. Jeder Code wird zufällig erzeugt
        und ist erst nach der Aktivierung beim Verkauf im Onlineshop einlösbar.'''
    frontend_updated = replace_once(frontend_original, description_old, description_new, 'Gutscheinbeschreibung')

    button_needle = '''      <button id="gutscheineNeuLadenButton" type="button">'''
    button_insert = '''      <button id="fuenfEuroGutscheinButton" type="button">
        + 5-€-Gutschein erstellen
      </button>
      <p id="gutscheinErstellenStatus" role="status" style="line-height:1.6; margin-top:10px;"></p>

'''
    frontend_updated = replace_once(frontend_updated, button_needle, button_insert + button_needle, 'Gutschein erstellen-Schaltfläche')

    function_needle = '''    function gutscheinStatusText(status) {'''
    function_insert = '''    // Druckvorlage für einzeln erstellte 5-Euro-Gutscheine.
    function fuenfEuroGutscheinDrucken(voucher) {
      const code = String(voucher.code || "").toUpperCase();
      if (!/^DRG-[A-Z0-9-]+$/.test(code)) {
        alert("Der Gutscheincode ist ungültig.");
        return;
      }

      const druckFenster = window.open("", "_blank", "width=850,height=650");
      if (!druckFenster) {
        alert("Bitte Pop-ups erlauben, um den Gutschein zu drucken.");
        return;
      }

      druckFenster.document.write(`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Dragemor Pottery – 5 € Gutschein</title>
<style>
  @page { size: A6 landscape; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #3a372f; font-family: Georgia, serif; }
  .karte {
    width: 148mm; height: 105mm; padding: 9mm;
    background: #f2eee4; border: 2mm solid #e4d9c6;
    display: flex; flex-direction: column; align-items: center;
    justify-content: space-between; text-align: center;
  }
  .marke { font-size: 19pt; font-weight: bold; letter-spacing: 2px; }
  .untertitel { font-size: 10pt; letter-spacing: 2.5px; text-transform: uppercase; }
  .wert { font-size: 55pt; line-height: 1; color: #705b45; }
  .zeile { font-size: 11pt; line-height: 1.4; }
  .code { font: bold 11pt Arial, sans-serif; letter-spacing: 1px; padding: 2mm 5mm; border: 1px solid #aa9a84; }
  .url { font: 9pt Arial, sans-serif; }
</style>
</head>
<body><div class="karte">
  <div class="marke">DRAGEMOR POTTERY</div>
  <div class="untertitel">Geschenkgutschein</div>
  <div class="wert">5 €</div>
  <div class="zeile">Für einen besonderen Moment.<br>Handgemachte Keramik &amp; Leder</div>
  <div class="code">${code}</div>
  <div class="url">dragemor-pottery.de · Im Warenkorb einlösen</div>
</div></body></html>`);
      druckFenster.document.close();
      druckFenster.onload = () => {
        druckFenster.focus();
        druckFenster.print();
      };
    }

    async function erstelleFuenfEuroGutschein() {
      const button = document.getElementById("fuenfEuroGutscheinButton");
      const status = document.getElementById("gutscheinErstellenStatus");
      button.disabled = true;
      status.textContent = "Der Gutschein wird erstellt …";

      try {
        const response = await fetch("/api/admin-products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "create-five-euro-voucher" })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.voucher?.code) {
          throw new Error(data.error || "Der Gutschein konnte nicht erstellt werden.");
        }
        status.textContent = `5-€-Gutschein ${data.voucher.code} ist vorbereitet. Vor dem Einlösen bitte aktivieren.`;
        await ladeGutscheine();
      } catch (error) {
        status.textContent = error.message || "Der Gutschein konnte nicht erstellt werden.";
      } finally {
        button.disabled = false;
      }
    }

'''
    frontend_updated = replace_once(frontend_updated, function_needle, function_insert + function_needle, 'Druck- und Erstellfunktionen')

    print_needle = '''          card.appendChild(copyButton);

          if (voucher.status === "prepared"'''
    print_insert = '''          card.appendChild(copyButton);

          if (Number(voucher.initial_value) === 500) {
            const printButton = document.createElement("button");
            printButton.type = "button";
            printButton.style.marginTop = "10px";
            printButton.textContent = "5-€-Gutschein drucken";
            printButton.addEventListener("click", () => fuenfEuroGutscheinDrucken(voucher));
            card.appendChild(printButton);
          }

          if (voucher.status === "prepared"'''
    frontend_updated = replace_once(frontend_updated, print_needle, print_insert, 'Druck-Schaltfläche')

    listener_needle = '''    document.getElementById("gutscheineNeuLadenButton")?.addEventListener("click", ladeGutscheine);'''
    listener_insert = '''    document.getElementById("fuenfEuroGutscheinButton")?.addEventListener("click", erstelleFuenfEuroGutschein);
'''
    frontend_updated = replace_once(frontend_updated, listener_needle, listener_insert + listener_needle, 'Erstellen-Ereignis')

    if len(backend_updated) <= len(backend_original) or len(frontend_updated) <= len(frontend_original):
        raise AssertionError('Sicherheitsprüfung fehlgeschlagen')
    if '--check' in sys.argv:
        print('Prüfung erfolgreich: beide Dateien können angepasst werden. Noch nichts geändert.')
        return

    # Sicherheitskopie vor dem Überschreiben.
    BACKEND.with_name('admin-products.js.vor-5-euro.bak').write_text(backend_original, encoding='utf-8')
    FRONTEND.with_name('admin.html.vor-5-euro.bak').write_text(frontend_original, encoding='utf-8')
    BACKEND.write_text(backend_updated, encoding='utf-8')
    FRONTEND.write_text(frontend_updated, encoding='utf-8')
    print('Fertig: 5-€-Gutschein an API und Adminbereich ergänzt. Bitte beide Dateien committen und deployen.')
    print('Der eigentliche 5-€-Gutschein wird danach im Adminbereich erstellt; zunächst ist er nicht aktiv.')


if __name__ == '__main__':
    main()
