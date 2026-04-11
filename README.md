# OpenCV.js Document Scanner (Scanbot-like)

Projekat je sada potpuno prebacen na cist OpenCV.js scanner bez legacy slojeva.

## Sta sada radi

- Live detekcija ivica dokumenta preko kamere
- Stabilizacija kontura kroz vise frame-ova
- Auto-crop kada je dokument stabilno pronadjen
- Upload slike + detekcija + perspektivni crop
- Jedinstven SDK sloj: `mini-scanbot.js`

## Arhitektura

- `mini-scanbot.js`
  - Standalone OpenCV.js engine
  - Downscaled detekcija za veci FPS
  - Dynamic Canny threshold na osnovu osvetljenja
  - Contour scoring (area, ratio, ugaoni kvalitet, pozicija)
  - Perspektivni crop (`warpPerspective`)
- `script.js`
  - Kamera loop, overlay, auto-capture, upload tok
- `index.html`
  - UI + ucitavanje OpenCV.js i MiniScanbot SDK

## Pokretanje

1. Pokreni staticki server iz root foldera:

```powershell
python -m http.server 8080
```

2. Otvori aplikaciju:

```text
http://localhost:8080
```

## Napomena za produkciju

Za produkciju hostuj OpenCV.js i `mini-scanbot.js` lokalno na svom domenu.
