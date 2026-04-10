# Scanbot Web Document Scanner (Vanilla JS)

Ovaj projekat je resetovan od nule i sada koristi iskljucivo **Scanbot Web Document Scanner SDK**.

## Funkcionalnosti

- Kamera skener preko Scanbot Classic UI (`createDocumentScanner`)
- Live detekcija ivica dokumenta u kameri
- Auto-capture u camera modu
- Upload slike dokumenta
- Detekcija ivica na upload slici (`detectDocument`)
- Iscrtavanje detektovanog poligona preko slike
- Auto-crop upload slike preko Scanbot Cropping View API

## Brzi start

1. Pokreni staticki server iz root foldera:

```powershell
python -m http.server 8080
```

2. Otvori:

```text
http://localhost:8080
```

## License key

U [script.js](script.js) podesi:

- `LICENSE_KEY`

Napomena: bez license key-a SDK radi ograniceno (trial sesija).

## Produkcija

Za produkciju nemoj koristiti CDN import. Preporuka je da Scanbot bundle i wasm fajlove hostujes na svom domenu i postavis `enginePath` ka lokalnoj putanji.
