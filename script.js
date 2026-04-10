const state = {
  engineReady: false,
};

const refs = {
  sdkState: document.querySelector("#sdkState"),
  activityState: document.querySelector("#activityState"),
  detectionState: document.querySelector("#detectionState"),
  startCameraBtn: document.querySelector("#startCameraBtn"),
  stopCameraBtn: document.querySelector("#stopCameraBtn"),
  fileInput: document.querySelector("#fileInput"),
  fileLabel: document.querySelector("#fileLabel"),
  cameraBadge: document.querySelector("#cameraBadge"),
  uploadBadge: document.querySelector("#uploadBadge"),
  cameraPlaceholder: document.querySelector("#cameraPlaceholder"),
  cameraPreview: document.querySelector("#cameraPreview"),
  cameraOverlay: document.querySelector("#cameraOverlay"),
  uploadPreview: document.querySelector("#uploadPreview"),
  uploadOverlay: document.querySelector("#uploadOverlay"),
  uploadPlaceholder: document.querySelector("#uploadPlaceholder"),
  originalResult: document.querySelector("#originalResult"),
  croppedResult: document.querySelector("#croppedResult"),
};

function setSdkState(text) {
  refs.sdkState.textContent = text;
}

function setActivity(text) {
  refs.activityState.textContent = text;
}

function setDetection(text) {
  refs.detectionState.textContent = text;
}

function setCameraBadge(text) {
  refs.cameraBadge.textContent = text;
}

function setUploadBadge(text) {
  refs.uploadBadge.textContent = text;
}

function setResultImages(dataUrl) {
  refs.originalResult.src = dataUrl;
  refs.croppedResult.src = dataUrl;
}

function clearImagePreview() {
  refs.originalResult.removeAttribute("src");
  refs.croppedResult.removeAttribute("src");
  refs.uploadPreview.removeAttribute("src");
  refs.uploadPreview.style.display = "none";
  refs.uploadPlaceholder.style.display = "grid";

  const overlayContext = refs.uploadOverlay.getContext("2d");
  overlayContext.clearRect(0, 0, refs.uploadOverlay.width, refs.uploadOverlay.height);
}

function waitForScannerJs(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    const check = () => {
      if (window.scanner && typeof window.scanner.scan === "function") {
        resolve();
        return;
      }

      if (Date.now() - started >= timeoutMs) {
        reject(new Error("scanner.js nije ucitan."));
        return;
      }

      window.setTimeout(check, 60);
    };

    check();
  });
}

async function initScanner() {
  if (state.engineReady) {
    return;
  }

  setSdkState("Ucitavam scanner.js...");
  await waitForScannerJs();
  state.engineReady = true;
  setSdkState("Engine spreman (scanner.js)");
}

function hideLivePreviewArea() {
  refs.cameraPreview.style.display = "none";
  refs.cameraOverlay.style.display = "none";
  refs.cameraPlaceholder.style.display = "grid";
}

function normalizeScannedImages(response) {
  if (!window.scanner || typeof window.scanner.getScannedImages !== "function") {
    return [];
  }

  try {
    const scannedImages = window.scanner.getScannedImages(response, true, false);
    return Array.isArray(scannedImages) ? scannedImages : [];
  } catch (error) {
    console.error("Failed to parse scanner.js response", error);
    return [];
  }
}

function handleScanResult(successful, message, response) {
  if (!successful) {
    setCameraBadge("Greska");
    setActivity(`Skeniranje nije uspelo: ${message || "nepoznata greska"}`);
    setDetection("Greska skeniranja");
    refs.stopCameraBtn.disabled = false;
    return;
  }

  if (typeof message === "string" && message.toLowerCase().includes("user cancel")) {
    setCameraBadge("Otkazano");
    setActivity("Skeniranje je otkazano");
    setDetection("Nema rezultata");
    refs.stopCameraBtn.disabled = false;
    return;
  }

  const scannedImages = normalizeScannedImages(response);
  if (!scannedImages.length) {
    setCameraBadge("Bez rezultata");
    setActivity("Scanner.js nije vratio slike");
    setDetection("Nije detektovan dokument");
    refs.stopCameraBtn.disabled = false;
    return;
  }

  const firstPage = scannedImages[0];
  if (!firstPage || !firstPage.src) {
    setCameraBadge("Neispravan odgovor");
    setActivity("Skeniranje je zavrseno bez validnog image src");
    setDetection("Nema prikaza");
    refs.stopCameraBtn.disabled = false;
    return;
  }

  setResultImages(firstPage.src);
  refs.uploadPreview.src = firstPage.src;
  refs.uploadPreview.style.display = "block";
  refs.uploadPlaceholder.style.display = "none";

  setCameraBadge("Zavrseno");
  setUploadBadge("Skenirana slika prikazana");
  setActivity(`Scanner.js vratio ${scannedImages.length} strana`);
  setDetection("Dokument preuzet iz scanner.js sesije");
  refs.stopCameraBtn.disabled = false;
}

async function startScannerSession() {
  try {
    await initScanner();
    hideLivePreviewArea();
    setCameraBadge("Skeniranje...");
    setActivity("Otvaram scanner.js dijalog");
    setDetection("Ceka izlaz iz scan dijaloga");
    refs.stopCameraBtn.disabled = false;

    const scanRequest = {
      source_name: "select",
      use_asprise_dialog: true,
      show_scanner_ui: false,
      output_settings: [
        {
          type: "return-base64",
          format: "jpg",
          jpeg_quality: 92,
        },
      ],
    };

    window.scanner.scan(handleScanResult, scanRequest);
  } catch (error) {
    console.error("Could not start scanner.js session", error);
    setCameraBadge("Greska");
    setActivity("Ne mogu da pokrenem scanner.js");
    setDetection("Engine nije spreman");
    refs.stopCameraBtn.disabled = false;
  }
}

function stopScannerSession() {
  hideLivePreviewArea();
  clearImagePreview();
  refs.fileLabel.textContent = "Nijedna slika nije izabrana.";
  setCameraBadge("Neaktivno");
  setUploadBadge("Ceka sliku");
  setActivity("Prikaz ociscen");
  setDetection("-");
  refs.stopCameraBtn.disabled = true;
}

async function processUpload(file) {
  try {
    await initScanner();
    refs.fileLabel.textContent = `Fajl: ${file.name}`;
    setUploadBadge("Ucitan fajl");
    setActivity("Upload slike uspesan");
    setDetection("Upload putanja aktivna");

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    refs.uploadPreview.src = dataUrl;
    refs.uploadPreview.style.display = "block";
    refs.uploadPlaceholder.style.display = "none";
    setResultImages(dataUrl);
    refs.stopCameraBtn.disabled = false;
  } catch (error) {
    console.error("Upload processing error", error);
    setUploadBadge("Greska");
    setActivity("Greska tokom obrade upload slike");
    setDetection("Greska");
  }
}

function wireEvents() {
  refs.startCameraBtn.addEventListener("click", () => {
    void startScannerSession();
  });

  refs.stopCameraBtn.addEventListener("click", () => {
    stopScannerSession();
  });

  refs.fileInput.addEventListener("change", (event) => {
    const input = event.currentTarget;
    const file = input?.files?.[0];
    if (!file) {
      return;
    }

    void processUpload(file);
    input.value = "";
  });
}

async function bootstrap() {
  hideLivePreviewArea();
  wireEvents();

  try {
    await initScanner();
    setActivity("Spreman za scanner.js i upload");
    setDetection("Ceka skeniranje");
  } catch (error) {
    console.error("Engine bootstrap failed", error);
    setSdkState("Inicijalizacija nije uspela");
    setActivity("Aplikacija nije spremna");
    setDetection("Greska");
  }
}

void bootstrap();
