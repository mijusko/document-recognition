# Document Recognition (frontend)

This repository contains a browser-only document recognition / scanner app using HTML/CSS/JS with Python (Pyodide) and an in-browser deep segmentation model (BiRefNet via Transformers.js).

Quick notes
- Static site — no backend required. Netlify can publish the project root.
- The app loads a DL model (~100MB) on first visit; prefer testing on a fast connection.
- To run locally:

```powershell
python -m http.server 8080
# then open http://localhost:8080 in your browser
```

Netlify deploy
- Connect this GitHub repo in Netlify and set publish directory to `/` (project root). No build command is required for the current static setup.
