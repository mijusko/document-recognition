const state = {
  scanner: null,
  engineReady: false,
  cameraStream: null,
  cameraLoopId: null,
  frameCanvas: null,
  frameCtx: null,
  runningDetection: false,
  cropInFlight: false,
  lastDetectionAt: 0,
  detectionEveryMs: 85,
  stableFrames: 0,
  requiredStableFrames: 3,
  cooldownUntil: 0,
  framesWithoutDetection: 0,
  overlayHoldFrames: 4,
  cornerSmoothing: 0.34,
  lastUploadCorners: null,
  lastCameraCorners: null,
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
  cameraPlaceholder: document.querySelector("#cameraPlaceholder"),
  cameraPreview: document.querySelector("#cameraPreview"),
  cameraOverlay: document.querySelector("#cameraOverlay"),
  uploadStage: document.querySelector("#uploadStage"),
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

function setupCanvasForElement(canvas, container) {
  const bounds = container.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;

  canvas.width = Math.max(1, Math.round(bounds.width * ratio));
  canvas.height = Math.max(1, Math.round(bounds.height * ratio));

  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);

  return {
    context,
    width: bounds.width,
    height: bounds.height,
  };
}

function cornersToArray(corners) {
  if (!corners || typeof corners !== "object") {
    return null;
  }

  const points = [
    corners.topLeft,
    corners.topRight,
    corners.bottomRight,
    corners.bottomLeft,
  ];

  const valid = points.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
  return valid ? points : null;
}

function cloneCorners(corners) {
  if (!corners) {
    return null;
  }

  return {
    topLeft: { x: corners.topLeft.x, y: corners.topLeft.y },
    topRight: { x: corners.topRight.x, y: corners.topRight.y },
    bottomRight: { x: corners.bottomRight.x, y: corners.bottomRight.y },
    bottomLeft: { x: corners.bottomLeft.x, y: corners.bottomLeft.y },
  };
}

function blendCorners(previous, current, alpha) {
  if (!previous) {
    return cloneCorners(current);
  }

  const mixPoint = (prev, next) => ({
    x: (prev.x * (1 - alpha)) + (next.x * alpha),
    y: (prev.y * (1 - alpha)) + (next.y * alpha),
  });

  return {
    topLeft: mixPoint(previous.topLeft, current.topLeft),
    topRight: mixPoint(previous.topRight, current.topRight),
    bottomRight: mixPoint(previous.bottomRight, current.bottomRight),
    bottomLeft: mixPoint(previous.bottomLeft, current.bottomLeft),
  };
}

function getSourceDimensions(source) {
  const width = source?.videoWidth || source?.naturalWidth || source?.width || 0;
  const height = source?.videoHeight || source?.naturalHeight || source?.height || 0;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

function drawPolygon({ canvas, container, sourceWidth, sourceHeight, corners }) {
  const setup = setupCanvasForElement(canvas, container);
  if (!Array.isArray(corners) || corners.length !== 4) {
    return;
  }

  const mediaRect = getContainRect(sourceWidth, sourceHeight, setup.width, setup.height);
  const scaled = corners.map((point) => ({
    x: mediaRect.x + ((point.x / sourceWidth) * mediaRect.width),
    y: mediaRect.y + ((point.y / sourceHeight) * mediaRect.height),
  }));

  setup.context.save();
  setup.context.lineJoin = "round";
  setup.context.lineCap = "round";
  setup.context.lineWidth = 4;
  setup.context.strokeStyle = "rgba(115, 255, 215, 0.96)";
  setup.context.fillStyle = "rgba(115, 255, 215, 0.14)";
  setup.context.shadowColor = "rgba(115, 255, 215, 0.42)";
  setup.context.shadowBlur = 16;

  setup.context.beginPath();
  scaled.forEach((point, index) => {
    if (index === 0) {
      setup.context.moveTo(point.x, point.y);
      return;
    }
    setup.context.lineTo(point.x, point.y);
  });
  setup.context.closePath();
  setup.context.fill();
  setup.context.stroke();

  scaled.forEach((point, index) => {
    setup.context.beginPath();
    setup.context.arc(point.x, point.y, 5, 0, Math.PI * 2);
    setup.context.fillStyle = index === 0 ? "rgba(255, 125, 58, 0.98)" : "rgba(250, 255, 253, 0.98)";
    setup.context.fill();
  });

  setup.context.restore();
}

function clearUploadOverlay() {
  state.lastUploadCorners = null;
  setupCanvasForElement(refs.uploadOverlay, refs.uploadStage);
}

function clearCameraOverlay() {
  state.lastCameraCorners = null;
  setupCanvasForElement(refs.cameraOverlay, refs.scannerContainer);
}

function drawUploadOverlay() {
  const corners = cornersToArray(state.lastUploadCorners);
  if (!corners || !refs.uploadPreview.naturalWidth || !refs.uploadPreview.naturalHeight) {
    clearUploadOverlay();
    return;
  }

  drawPolygon({
    canvas: refs.uploadOverlay,
    container: refs.uploadStage,
    sourceWidth: refs.uploadPreview.naturalWidth,
    sourceHeight: refs.uploadPreview.naturalHeight,
    corners,
  });
}

function drawCameraOverlay() {
  const corners = cornersToArray(state.lastCameraCorners);
  const sourceWidth = refs.cameraPreview.videoWidth;
  const sourceHeight = refs.cameraPreview.videoHeight;

  if (!corners || !sourceWidth || !sourceHeight) {
    clearCameraOverlay();
    return;
  }

  drawPolygon({
    canvas: refs.cameraOverlay,
    container: refs.scannerContainer,
    sourceWidth,
    sourceHeight,
    corners,
  });
}

function waitForMiniScanbot(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const check = () => {
      if (typeof window.MiniScanbot === "function") {
        resolve();
        return;
      }

      if ((Date.now() - startedAt) >= timeoutMs) {
        reject(new Error("MiniScanbot nije ucitan."));
        return;
      }

      window.setTimeout(check, 50);
    };

    check();
  });
}

async function initScanner() {
  if (state.engineReady && state.scanner) {
    return;
  }

  setSdkState("Ucitavam OpenCV.js scanner...");
  await waitForMiniScanbot();
  state.scanner = await window.MiniScanbot.initialize({
    maxDetectionDimension: 1024,
    minAreaRatio: 0.07,
    minLongShortRatio: 1.14,
    fallbackAreaRatio: 0.045,
    cannyLow: 48,
    cannyHighMultiplier: 2.45,
  });
  state.engineReady = true;
  setSdkState("OpenCV SDK spreman");
}

function ensureFrameBuffer() {
  if (!state.frameCanvas) {
    state.frameCanvas = document.createElement("canvas");
    state.frameCtx = state.frameCanvas.getContext("2d", { willReadFrequently: true });
  }

  const width = refs.cameraPreview.videoWidth;
  const height = refs.cameraPreview.videoHeight;
  if (width && height) {
    state.frameCanvas.width = width;
    state.frameCanvas.height = height;
  }
}

function detectDocument(source) {
  try {
    return state.scanner.detectDocument(source);
  } catch (error) {
    return null;
  }
}

function extractDocumentDataUrl(source, corners, options) {
  return state.scanner.extractReceiptDataUrl(source, corners, options);
}

function createCanvasSnapshot(sourceCanvas) {
  const snapshot = document.createElement("canvas");
  snapshot.width = sourceCanvas.width;
  snapshot.height = sourceCanvas.height;
  const context = snapshot.getContext("2d");
  context.drawImage(sourceCanvas, 0, 0, snapshot.width, snapshot.height);
  return snapshot;
}

async function stopCameraScanner() {
  if (state.cameraLoopId) {
    cancelAnimationFrame(state.cameraLoopId);
    state.cameraLoopId = null;
  }

  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
  }

  refs.cameraPreview.pause();
  refs.cameraPreview.srcObject = null;
  refs.cameraPreview.style.display = "none";
  refs.cameraOverlay.style.display = "none";
  refs.cameraPlaceholder.style.display = "grid";
  refs.startCameraBtn.disabled = false;
  refs.stopCameraBtn.disabled = true;

  state.stableFrames = 0;
  state.framesWithoutDetection = 0;
  state.runningDetection = false;
  state.cropInFlight = false;
  clearCameraOverlay();
  setCameraBadge("Neaktivno");
  setActivity("Kamera zaustavljena");
}

async function autoCropCurrentFrame(corners) {
  if (!state.frameCanvas || state.cropInFlight || !corners) {
    return;
  }

  state.cropInFlight = true;

  try {
    const snapshot = createCanvasSnapshot(state.frameCanvas);
    refs.originalResult.src = snapshot.toDataURL("image/jpeg", 0.92);

    const cropDataUrl = extractDocumentDataUrl(snapshot, corners, {
      mode: "color",
      jpegQuality: 0.93,
    });

    if (cropDataUrl) {
      refs.croppedResult.src = cropDataUrl;
      setActivity("Auto-crop zavrsen (kamera)");
    }
  } finally {
    state.cropInFlight = false;
    window.setTimeout(() => {
      if (state.cameraStream) {
        setCameraBadge("Aktivno");
      }
    }, 900);
  }
}

async function runCameraDetectionTick() {
  if (!state.cameraStream || state.runningDetection) {
    return;
  }

  const now = performance.now();
  if (now - state.lastDetectionAt < state.detectionEveryMs) {
    return;
  }
  state.lastDetectionAt = now;

  ensureFrameBuffer();
  if (!state.frameCanvas.width || !state.frameCanvas.height) {
    return;
  }

  state.frameCtx.drawImage(refs.cameraPreview, 0, 0, state.frameCanvas.width, state.frameCanvas.height);

  state.runningDetection = true;
  let detection = null;

  try {
    detection = detectDocument(state.frameCanvas);
  } catch (error) {
    console.error("Camera detection error", error);
    setDetection("Greska detekcije");
  } finally {
    state.runningDetection = false;
  }

  if (detection && detection.corners) {
    const smoothedCorners = blendCorners(state.lastCameraCorners, detection.corners, state.cornerSmoothing);
    state.lastCameraCorners = smoothedCorners;
    state.framesWithoutDetection = 0;
    drawCameraOverlay();

    const confidence = Math.round((detection.confidence || 0) * 100);
    setDetection(`Dokument pronadjen (${confidence}%)`);

    if ((detection.confidence || 0) >= 0.55 && (detection.areaRatio || 0) >= 0.12) {
      state.stableFrames += 1;
    } else {
      state.stableFrames = 0;
    }

    if (
      state.stableFrames >= state.requiredStableFrames
      && Date.now() > state.cooldownUntil
      && !state.cropInFlight
    ) {
      state.cooldownUntil = Date.now() + 2500;
      state.stableFrames = 0;
      setCameraBadge("Auto-crop...");
      const cornersSnapshot = cloneCorners(smoothedCorners);
      window.setTimeout(() => {
        void autoCropCurrentFrame(cornersSnapshot);
      }, 0);
    }

    return;
  }

  state.stableFrames = 0;
  state.framesWithoutDetection += 1;
  if (state.framesWithoutDetection >= state.overlayHoldFrames) {
    clearCameraOverlay();
  }
  setDetection("Cekam dokument");
}

function cameraLoop() {
  void runCameraDetectionTick();
  if (state.cameraStream) {
    state.cameraLoopId = requestAnimationFrame(cameraLoop);
  }
}

async function startCameraScanner() {
  try {
    await initScanner();
    await stopCameraScanner();

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });

    state.cameraStream = stream;
    refs.cameraPreview.srcObject = stream;
    await refs.cameraPreview.play();

    refs.cameraPreview.style.display = "block";
    refs.cameraOverlay.style.display = "block";
    refs.cameraPlaceholder.style.display = "none";
    refs.startCameraBtn.disabled = true;
    refs.stopCameraBtn.disabled = false;

    setCameraBadge("Aktivno");
    setActivity("Live kamera aktivna");
    setDetection("Cekam dokument");

    cameraLoop();
  } catch (error) {
    console.error("Could not start camera", error);
    await stopCameraScanner();
    setCameraBadge("Greska");
    setActivity("Ne mogu da pokrenem kameru");
  }
}

function setUploadPreview(dataUrl) {
  refs.uploadPreview.src = dataUrl;
  refs.uploadPreview.style.display = "block";
  refs.uploadPlaceholder.style.display = "none";
}

async function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function processUpload(file) {
  try {
    await initScanner();
    refs.fileLabel.textContent = `Fajl: ${file.name}`;
    setUploadBadge("Analiziram");
    setActivity("Upload analiza pokrenuta");

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    setUploadPreview(dataUrl);
    refs.originalResult.src = dataUrl;

    const image = await loadImageFromDataUrl(dataUrl);
    const detection = detectDocument(image);

    if (!detection || !detection.corners) {
      setUploadBadge("Nije nadjen dokument");
      setDetection("Nije detektovano");
      refs.croppedResult.removeAttribute("src");
      clearUploadOverlay();
      return;
    }

    state.lastUploadCorners = cloneCorners(detection.corners);
    drawUploadOverlay();
    setUploadBadge("Ivice detektovane");
    setDetection(`Dokument pronadjen (${Math.round((detection.confidence || 0) * 100)}%)`);

    const cropDataUrl = extractDocumentDataUrl(image, detection.corners, {
      mode: "color",
      jpegQuality: 0.93,
    });

    if (cropDataUrl) {
      refs.croppedResult.src = cropDataUrl;
      setUploadBadge("Auto-crop zavrsen");
      setActivity("Upload detekcija i crop zavrseni");
    } else {
      refs.croppedResult.removeAttribute("src");
      setUploadBadge("Crop neuspesan");
      setActivity("Detekcija uspela, crop neuspesan");
    }
  } catch (error) {
    console.error("Upload processing error", error);
    clearUploadOverlay();
    setUploadBadge("Greska");
    setActivity("Greska tokom upload analize");
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

    void processUpload(file);
    input.value = "";
  });

  refs.uploadPreview.addEventListener("load", () => {
    drawUploadOverlay();
  });

  window.addEventListener("resize", () => {
    drawUploadOverlay();
    drawCameraOverlay();
  });

  window.addEventListener("beforeunload", () => {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((track) => track.stop());
    }
    if (state.scanner && typeof state.scanner.destroy === "function") {
      state.scanner.destroy();
    }
  });
}

async function bootstrap() {
  wireEvents();

  try {
    await initScanner();
    setActivity("Spreman za kameru i upload");
    setDetection("Ceka skeniranje");
  } catch (error) {
    console.error("Engine bootstrap failed", error);
    setSdkState("Inicijalizacija nije uspela");
    setActivity("Aplikacija nije spremna");
    setDetection("Greska");
  }
}

void bootstrap();
