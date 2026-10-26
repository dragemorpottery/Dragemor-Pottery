#!/usr/bin/env python3
"""Dragemor Pottery: vorhandenes Gutscheinmotiv fuer den Druck verwenden.

Ergaenzt in admin.html die Druckfunktion. Der Gutscheinwert und der
individuelle Code stehen in der vorhandenen Zeile "Wert". Die
Funktion unterstuetzt die bestehenden Werte (5/15/25/50 Euro).

Vorbereitung: Diese Datei in den Projekt-Hauptordner hochladen und
'dragemor_gutschein_vorlage.png' in denselben Ordner (alternativ unter
'bilder/gutschein-vorlage-dragemor.png').

Ausfuehren:
    python3 gutschein_druckvorlage_patch.py --check
    python3 gutschein_druckvorlage_patch.py

Danach NUR admin.html und bilder/gutschein-vorlage-dragemor.png
committen und pushen. Vorhandene Gutscheine/Daten bleiben unveraendert.
"""
from pathlib import Path
import shutil
import sys

ROOT = Path.cwd()
FRONTEND = ROOT / "admin.html"
IMAGE_PATH = ROOT / "bilder" / "gutschein-vorlage-dragemor.png"
IMAGE_SOURCE = ROOT / "dragemor_gutschein_vorlage.png"
OLD_FN_START = "    function fuenfEuroGutscheinDrucken(voucher) {"
OLD_FN_END = "    async function erstelleFuenfEuroGutschein() {"
OLD_PRINT = '''          if (Number(voucher.initial_value) === 500) {
            const printButton = document.createElement("button");
            printButton.type = "button";
            printButton.style.marginTop = "10px";
            printButton.textContent = "5-€-Gutschein drucken";
            printButton.addEventListener("click", () => fuenfEuroGutscheinDrucken(voucher));
            card.appendChild(printButton);
          }'''
NEW_PRINT = '''          const printButton = document.createElement("button");
          printButton.type = "button";
          printButton.style.marginTop = "10px";
          printButton.textContent = "Gutschein drucken";
          printButton.addEventListener("click", () => gutscheinDrucken(voucher));
          card.appendChild(printButton);'''

NEW_FN = '''    // Druck mit der Original-Gutscheinvorlage und individuellem Wert/Code.
    function gutscheinDrucken(voucher) {
      const code = String(voucher.code || "").trim().toUpperCase();
      const cent = Number(voucher.initial_value);
      if (!/^DRG-[A-Z0-9-]+$/.test(code) || !Number.isInteger(cent) || cent <= 0) {
        alert("Gutscheincode oder Wert ist ungültig.");
        return;
      }
      const wert = (cent / 100).toLocaleString("de-DE", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      }) + " €";
      const bildUrl = new URL("/bilder/gutschein-vorlage-dragemor.png", window.location.origin).href;
      const druckFenster = window.open("", "_blank", "width=900,height=700");
      if (!druckFenster) {
        alert("Bitte Pop-ups erlauben, um den Gutschein zu drucken.");
        return;
      }

      druckFenster.document.write(`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Dragemor Pottery – Gutschein ${wert}</title>
<style>
  @page { size: A6 landscape; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 148mm; height: 105mm; }
  .karte { position: relative; width: 148mm; height: 105mm; overflow: hidden; }
  .vorlage { display: block; width: 100%; height: 100%; }
  .eintrag {
    position: absolute; left: 49%; top: 54.9%;
    display: flex; align-items: baseline; gap: 2mm;
    padding: 0.1mm 1.1mm 0.7mm;
    background: #f8f3e9; color: #443b2e;
    white-space: nowrap;
    font: 10.3pt/1.2 Georgia, 'Times New Roman', serif;
  }
  .eintrag .code { font-weight: 600; letter-spacing: 0.05mm; }
  @media screen { body { background: #fff; } }
</style>
</head>
<body>
  <div class="karte">
    <img class="vorlage" id="gutscheinVorlage" src="${bildUrl}" alt="Dragemor Pottery Gutscheinvorlage">
    <div class="eintrag"><span>${wert}</span><span>Code:</span><span class="code">${code}</span></div>
  </div>
</body></html>`);
      druckFenster.document.close();
      const bild = druckFenster.document.getElementById("gutscheinVorlage");
      const drucken = () => { druckFenster.focus(); druckFenster.print(); };
      const fehler = () => { druckFenster.alert("Gutscheinvorlage konnte nicht geladen werden. Bitte Bild in GitHub prüfen."); };
      if (bild.complete) {
        if (bild.naturalWidth > 0) drucken();
        else fehler();
      } else {
        bild.addEventListener("load", drucken, { once: true });
        bild.addEventListener("error", fehler, { once: true });
      }
    }

'''


def main():
    check = "--check" in sys.argv
    if not FRONTEND.is_file():
        sys.exit("Fehler: Bitte im Hauptordner des Dragemor-Pottery-Projekts ausführen.")
    if not (IMAGE_PATH.is_file() or IMAGE_SOURCE.is_file()):
        sys.exit("Fehler: Bild dragemor_gutschein_vorlage.png fehlt. Bitte erst hochladen.")
    original = FRONTEND.read_text(encoding="utf-8")
    if "function gutscheinDrucken(voucher)" in original:
        print("Druckvorlage bereits angepasst; keine weitere Änderung nötig.")
        return
    if original.count(OLD_FN_START) != 1 or original.count(OLD_FN_END) != 1 or original.count(OLD_PRINT) != 1:
        sys.exit("Sicherheitsstopp: Die erwarteten Stellen in admin.html wurden nicht eindeutig gefunden. Keine Datei geändert.")
    before, rest = original.split(OLD_FN_START, 1)
    _old_function, after = rest.split(OLD_FN_END, 1)
    updated = before + NEW_FN + OLD_FN_END + after
    updated = updated.replace(OLD_PRINT, NEW_PRINT, 1)
    if "function gutscheinDrucken(voucher)" not in updated or "function fuenfEuroGutscheinDrucken" in updated:
        sys.exit("Sicherheitsstopp: Änderung konnte nicht geprüft werden.")
    if check:
        print("Prüfung erfolgreich: Gutscheinbild gefunden, admin.html kann angepasst werden. Noch nichts geändert.")
        return
    backup = ROOT / "admin.html.vor-original-gutschein.bak"
    if not backup.exists():
        shutil.copy2(FRONTEND, backup)
    if not IMAGE_PATH.is_file():
        IMAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(IMAGE_SOURCE, IMAGE_PATH)
    FRONTEND.write_text(updated, encoding="utf-8")
    print("Fertig: Originalmotiv als Druckvorlage eingebaut.")
    print("Wert und Code erscheinen in der vorhandenen Wert-Zeile.")
    print("Drucken funktioniert für 5, 15, 25 und 50 Euro.")
    print("Nächster Schritt: git add admin.html bilder/gutschein-vorlage-dragemor.png")


if __name__ == "__main__":
    main()
