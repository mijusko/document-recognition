# jscanify Document Scanner - Vanilla Web App

Projekat je potpuno prebacen na **jscanify + OpenCV.js**.

## Sta sada radi

- Kamera skeniranje u browseru (`getUserMedia` + `jscanify`)
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

- OpenCV.js preko CDN skripte:
- `https://docs.opencv.org/4.7.0/opencv.js`
- jscanify preko CDN skripte:
- `https://cdn.jsdelivr.net/gh/ColonelParrot/jscanify@master/src/jscanify.min.js`

## Napomena za produkciju

Za produkciju izbegni CDN i hostuj OpenCV i jscanify bundle lokalno na svom domenu.
