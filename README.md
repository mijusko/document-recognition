# Document Scanner JS (WASM) - Vanilla Web App

Projekat je potpuno prebacen sa Scanbot SDK na **WASM document scanner engine (`scanic`)**.

## Sta sada radi

- Kamera skeniranje u browseru (`getUserMedia` + `scanic`)
- Live detekcija ivica dokumenta na video frame-ovima
- Iscrtavanje ivica (polygon overlay) preko kamere
- Auto-crop kada je detekcija stabilna kroz vise frame-ova
- Upload slike dokumenta
- Detekcija ivica na upload slici
- Automatski crop i prikaz rezultata

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

- `scanic` (WASM) preko CDN ESM importa:
- `https://cdn.jsdelivr.net/npm/scanic/+esm`

## Napomena za produkciju

Za produkciju izbegni CDN i hostuj `scanic` bundle na svom domenu.
