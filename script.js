import "https://cdn.jsdelivr.net/npm/scanbot-web-sdk@8.1.1/bundle/ScanbotSDK.ui2.min.js";

const ENGINE_PATH = "https://cdn.jsdelivr.net/npm/scanbot-web-sdk@8.1.1/bundle/bin/complete/";
const LICENSE_KEY = "";

const state = {
  sdk: null,
  scannerHandle: null,
  sdkReady: false,
  lastUploadPolygon: [],
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
  scannerContainer: document.querySelector("#scannerContainer"),
  uploadStage: document.querySelector("#uploadStage"),
  uploadPreview: document.querySelector("#uploadPreview"),
  uploadOverlay: document.querySelector("#uploadOverlay"),
  uploadPlaceholder: document.querySelector("#uploadPlaceholder"),
  originalResult: document.querySelector("#originalResult"),
  croppedResult: document.querySelector("#croppedResult"),
  autoCropContainer: document.querySelector("#autoCropContainer"),
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

function normalizePolygonPoint(point) {
  if (Array.isArray(point) && point.length >= 2) {
    return { x: Number(point[0]), y: Number(point[1]) };
  }

  if (point && typeof point === "object" && "x" in point && "y" in point) {
    return { x: Number(point.x), y: Number(point.y) };
  }

  return null;
}

function getContainRect(sourceWidth, sourceHeight, containerWidth, containerHeight) {
  if (!sourceWidth || !sourceHeight || !containerWidth || !containerHeight) {
    return { x: 0, y: 0, width: containerWidth, height: containerHeight };
  }

  const sourceRatio = sourceWidth / sourceHeight;
  const containerRatio = containerWidth / containerHeight;

  if (sourceRatio > containerRatio) {
    const width = containerWidth;
    const height = width / sourceRatio;
    return { x: 0, y: (containerHeight - height) / 2, width, height };
  }

  const height = containerHeight;
  const width = height * sourceRatio;
  return { x: (containerWidth - width) / 2, y: 0, width, height };
}

function setupOverlayCanvas() {
  const bounds = refs.uploadStage.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const canvas = refs.uploadOverlay;

  canvas.width = Math.max(1, Math.round(bounds.width * ratio));
  canvas.height = Math.max(1, Math.round(bounds.height * ratio));

  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);

  return { context, width: bounds.width, height: bounds.height };
}

function drawUploadOverlay() {
  const points = state.lastUploadPolygon;
  const preview = refs.uploadPreview;
  const canvas = setupOverlayCanvas();

  if (!Array.isArray(points) || points.length < 4 || !preview.naturalWidth || !preview.naturalHeight) {
    return;
  }

  const normalized = points
    .map(normalizePolygonPoint)
    .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));

  if (normalized.length < 4) {
    return;
  }

  const mediaRect = getContainRect(
    preview.naturalWidth,
    preview.naturalHeight,
    canvas.width,
    canvas.height,
  );

  const scaled = normalized.map((point) => ({
    x: mediaRect.x + (point.x * mediaRect.width),
    y: mediaRect.y + (point.y * mediaRect.height),
  }));

  canvas.context.save();
  canvas.context.lineJoin = "round";
  canvas.context.lineCap = "round";
  canvas.context.lineWidth = 4;
  canvas.context.strokeStyle = "rgba(115, 255, 215, 0.96)";
  canvas.context.fillStyle = "rgba(115, 255, 215, 0.16)";
  canvas.context.shadowColor = "rgba(115, 255, 215, 0.44)";
  canvas.context.shadowBlur = 14;

  canvas.context.beginPath();
  scaled.forEach((point, index) => {
    if (index === 0) {
      canvas.context.moveTo(point.x, point.y);
      return;
    }
    canvas.context.lineTo(point.x, point.y);
  });
  canvas.context.closePath();
  canvas.context.fill();
  canvas.context.stroke();

  scaled.forEach((point, index) => {
    canvas.context.beginPath();
    canvas.context.arc(point.x, point.y, 5, 0, Math.PI * 2);
    canvas.context.fillStyle = index === 0 ? "rgba(255, 125, 58, 0.98)" : "rgba(250, 255, 253, 0.98)";
    canvas.context.fill();
  });

  canvas.context.restore();
}

async function initSdk() {
  if (state.sdkReady && state.sdk) {
    return state.sdk;
  }

  setSdkState("Ucitavam Scanbot SDK...");

  state.sdk = await ScanbotSDK.initialize({
    enginePath: ENGINE_PATH,
    licenseKey: LICENSE_KEY,
    onComplete(error) {
      if (error) {
        console.error("Scanbot init error", error);
        setSdkState(`SDK greska: ${error.message || error}`);
      }
    },
  });

  state.sdkReady = true;
  setSdkState("SDK spreman");
  return state.sdk;
}

async function stopCameraScanner() {
  if (state.scannerHandle) {
    state.scannerHandle.dispose();
    state.scannerHandle = null;
  }

  refs.scannerContainer.innerHTML = "<div class=\"scanner-placeholder\">Pokreni kameru da vidis live ivice i auto-capture.</div>";
  refs.startCameraBtn.disabled = false;
  refs.stopCameraBtn.disabled = true;
  setCameraBadge("Neaktivno");
  setActivity("Kamera zaustavljena");
}

async function startCameraScanner() {
  try {
    await initSdk();
    await stopCameraScanner();

    refs.scannerContainer.innerHTML = "";
    refs.startCameraBtn.disabled = true;
    refs.stopCameraBtn.disabled = false;
    setCameraBadge("Aktivno");
    setActivity("Pokrecem live skener");

    state.scannerHandle = await state.sdk.createDocumentScanner({
      containerId: "scannerContainer",
      autoCaptureEnabled: true,
      autoCaptureSensitivity: 0.72,
      scannerConfiguration: {
        parameters: {
          acceptedAngleScore: 60,
          acceptedSizeScore: 60,
          ignoreOrientationMismatch: true,
        },
      },
      style: {
        outline: {
          polygon: {
            strokeWidthCapturing: 4,
            fillCapturing: "rgba(115, 255, 215, 0.14)",
            strokeCapturing: "#73ffd7",
            strokeWidthSearching: 3,
            fillSearching: "rgba(255, 146, 93, 0.1)",
            strokeSearching: "#ff925d",
          },
        },
      },
      onDocumentDetected: async (response) => {
        const detectionResult = response?.result?.detectionResult;
        setDetection(detectionResult?.status || "OK");
        setActivity("Dokument detektovan (kamera)");
        setCameraBadge("Detektovano");

        const displayedImage = response?.result?.croppedImage ?? response?.originalImage;
        if (displayedImage) {
          const jpeg = await state.sdk.imageToJpeg(displayedImage);
          const dataUrl = await state.sdk.toDataUrl(jpeg);
          refs.croppedResult.src = dataUrl;
        }

        if (response?.originalImage) {
          const originalJpeg = await state.sdk.imageToJpeg(response.originalImage);
          const originalDataUrl = await state.sdk.toDataUrl(originalJpeg);
          refs.originalResult.src = originalDataUrl;
        }

        window.setTimeout(() => {
          if (state.scannerHandle) {
            setCameraBadge("Aktivno");
          }
        }, 1200);
      },
      onError: (error) => {
        console.error("Camera scanner error", error);
        setActivity("Greska pri radu kamere");
      },
    });
  } catch (error) {
    console.error("Failed to start camera scanner", error);
    setActivity("Neuspesno pokretanje kamere");
    setDetection("Greska");
    refs.startCameraBtn.disabled = false;
    refs.stopCameraBtn.disabled = true;
    setCameraBadge("Greska");
  }
}

function setUploadPreview(dataUrl) {
  refs.uploadPreview.src = dataUrl;
  refs.uploadPreview.style.display = "block";
  refs.uploadPlaceholder.style.display = "none";
}

function clearUploadOverlay() {
  state.lastUploadPolygon = [];
  setupOverlayCanvas();
}

async function runAutoCrop(image, polygon) {
  const cropper = await state.sdk.openCroppingView({
    containerId: "autoCropContainer",
    image,
    polygon,
    disableScroll: true,
    rotations: 0,
    style: {
      padding: 0,
      polygon: {
        color: "#73ffd7",
        width: 2,
        handles: {
          size: 10,
          color: "white",
          border: "1px solid #d5d5d5",
        },
      },
      magneticLines: {
        color: "#ff6c45",
      },
    },
  });

  try {
    await cropper.detect();
    const result = await cropper.apply();
    return result?.image ?? null;
  } finally {
    cropper.dispose();
  }
}

async function handleFileUpload(file) {
  try {
    await initSdk();

    refs.fileLabel.textContent = `Fajl: ${file.name}`;
    setUploadBadge("Analiziram sliku");
    setActivity("Pokrenuta detekcija na upload slici");

    const buffer = new Uint8Array(await file.arrayBuffer());
    const image = ScanbotSDK.Config.Image.fromEncodedBinaryData(buffer);

    const originalJpeg = await state.sdk.imageToJpeg(image);
    const originalDataUrl = await state.sdk.toDataUrl(originalJpeg);
    refs.originalResult.src = originalDataUrl;
    setUploadPreview(originalDataUrl);

    const detection = await state.sdk.detectDocument(image);
    const status = detection?.status || "NOT_ACQUIRED";
    const polygon = Array.isArray(detection?.pointsNormalized) ? detection.pointsNormalized : [];

    setDetection(status);
    state.lastUploadPolygon = polygon;
    drawUploadOverlay();

    if (status !== "OK" || polygon.length < 4) {
      setUploadBadge("Nije nadjen dokument");
      refs.croppedResult.removeAttribute("src");
      setActivity("Detekcija zavrsena bez validnog dokumenta");
      return;
    }

    setUploadBadge("Ivice detektovane");
    const croppedImage = await runAutoCrop(image, polygon);

    if (!croppedImage) {
      refs.croppedResult.removeAttribute("src");
      setActivity("Auto-crop nije uspeo");
      return;
    }

    const croppedJpeg = await state.sdk.imageToJpeg(croppedImage);
    const croppedDataUrl = await state.sdk.toDataUrl(croppedJpeg);
    refs.croppedResult.src = croppedDataUrl;

    setActivity("Upload detekcija i auto-crop zavrseni");
    setUploadBadge("Auto-crop zavrsen");
  } catch (error) {
    console.error("Upload processing failed", error);
    clearUploadOverlay();
    setUploadBadge("Greska");
    setActivity("Greska u upload analizi");
    setDetection("Greska");
  }
}

function wireEvents() {
  refs.startCameraBtn.addEventListener("click", () => {
    void startCameraScanner();
  });

  refs.stopCameraBtn.addEventListener("click", () => {
    void stopCameraScanner();
  });

  refs.fileInput.addEventListener("change", (event) => {
    const input = event.currentTarget;
    const file = input?.files?.[0];
    if (!file) {
      return;
    }

    void handleFileUpload(file);
    input.value = "";
  });

  refs.uploadPreview.addEventListener("load", () => {
    drawUploadOverlay();
  });

  window.addEventListener("resize", () => {
    drawUploadOverlay();
  });
}

async function bootstrap() {
  wireEvents();

  try {
    await initSdk();
    setActivity("Spreman za kameru ili upload");
  } catch (error) {
    console.error("SDK bootstrap failed", error);
    setSdkState("SDK inicijalizacija nije uspela");
    setActivity("Aplikacija nije spremna");
    setDetection("Greska");
  }
}

void bootstrap();
