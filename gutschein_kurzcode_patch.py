#!/usr/bin/env python3
"""Kuerzt nur die Code-Erzeugung fuer neue 5-Euro-Gutscheine.

Bestehende Gutscheine und deren Datenbankeintraege bleiben unberuehrt.
"""
from pathlib import Path
import shutil
import sys

TARGET = Path("api/admin-products.js")
OLD = '''        const randomPart = crypto.randomBytes(9).toString("hex").toUpperCase();
        const code = `DRG-${randomPart.slice(0, 6)}-${randomPart.slice(6, 12)}-${randomPart.slice(12)}-05`;'''
NEW = '''        // Acht zufaellige, gut lesbare Zeichen; -05 kennzeichnet den Wert.
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const randomPart = Array.from(
          crypto.randomBytes(8),
          byte => alphabet[byte % alphabet.length]
        ).join("");
        const code = `DRG-${randomPart.slice(0, 4)}-${randomPart.slice(4)}-05`;'''

if not TARGET.is_file():
    sys.exit("Fehler: Datei api/admin-products.js nicht gefunden. Bitte im Projekt-Hauptordner ausfuehren.")

content = TARGET.read_text(encoding="utf-8")
if NEW in content:
    print("Bereits angepasst: Neue 5-Euro-Gutscheine haben das Format DRG-XXXX-XXXX-05.")
    sys.exit(0)
if content.count(OLD) != 1:
    sys.exit("Sicherheitsstopp: Die erwartete Code-Stelle wurde nicht genau einmal gefunden. Keine Datei geaendert.")

backup = Path("api/admin-products.js.vor-kurzcode.bak")
if not backup.exists():
    shutil.copy2(TARGET, backup)
TARGET.write_text(content.replace(OLD, NEW, 1), encoding="utf-8")
print("Erfolgreich: Neue 5-Euro-Gutscheine erhalten kuerzere Codes wie DRG-K7M4-Q9P2-05.")
print("Vorhandene Gutscheine bleiben unveraendert. Nur api/admin-products.js wurde angepasst.")
print("Naechster Schritt: Aenderung in GitHub speichern und veroeffentlichen.")
