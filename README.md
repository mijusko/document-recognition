# Scanner.js Document Scanner - Vanilla Web App

Projekat je potpuno prebacen na **scanner.js (Asprise)**.

## Sta sada radi

- Pokretanje scanner.js scan dijaloga
- Skeniranje preko dostupnog izvora (TWAIN/WIA uredjaji ili podrzani izvori)
- Vracanje skeniranih slika kao base64 i prikaz u rezultat panelu
- Upload slike dokumenta za lokalni prikaz u UI

## Pokretanje

1. Pokreni staticki server iz root foldera:

```powershell
python -m http.server 8080
```

2. Otvori aplikaciju:

```text
http://localhost:8080
```

## Tehnologija

- scanner.js preko CDN skripte:
- `https://asprise.azureedge.net/scannerjs/scanner.js`

## Napomena za produkciju

scanner.js za punu funkcionalnost zahteva Asprise Scan App instalaciju na masini korisnika.
Za produkciju je preporuceno hostovanje scanner.js fajlova sa sopstvenog domena.
