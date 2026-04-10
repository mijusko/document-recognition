const state = {
  scanner: null,
  engineReady: false,
  cameraStream: null,
  cameraLoopId: null,
  frameCanvas: null,
  frameCtx: null,
  runningDetection: false,
  lastDetectionAt: 0,
  detectionEveryMs: 130,
  stableFrames: 0,
  cooldownUntil: 0,
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

function getSourceDimensions(source) {
  const width = source?.videoWidth || source?.naturalWidth || source?.width || 0;
  const height = source?.videoHeight || source?.naturalHeight || source?.height || 0;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

function getContourMetrics(corners, sourceWidth, sourceHeight) {
  const points = cornersToArray(corners);
  if (!points || !sourceWidth || !sourceHeight) {
    return null;
  }

  const topWidth = pointDistance(corners.topLeft, corners.topRight);
  const bottomWidth = pointDistance(corners.bottomLeft, corners.bottomRight);
  const leftHeight = pointDistance(corners.topLeft, corners.bottomLeft);
  const rightHeight = pointDistance(corners.topRight, corners.bottomRight);

  const width = Math.max(topWidth, bottomWidth);
  const height = Math.max(leftHeight, rightHeight);
  const shorter = Math.max(1, Math.min(width, height));
  const longer = Math.max(width, height);

  return {
    areaRatio: polygonArea(points) / (sourceWidth * sourceHeight),
    longShortRatio: longer / shorter,
  };
}

function isLikelyReceiptContour(metrics) {
  if (!metrics) {
    return false;
  }

  // QR region is usually a small, near-square contour; receipts are larger and elongated.
  if (metrics.areaRatio < 0.085) {
    return false;
  }

  if (metrics.longShortRatio < 1.18) {
    return false;
  }

  return true;
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
  setup.context.fillStyle = "rgba(115, 255, 215, 0.16)";
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

function waitForPhotoScan(timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (typeof window.PhotoScan === "function") {
        resolve();
        return;
      }

      if (Date.now() - start >= timeoutMs) {
        reject(new Error("photoscan.js nije ucitan."));
        return;
      }

      window.setTimeout(check, 50);
    };

    check();
  });
}

function waitForOpenCv(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let finished = false;
    let runtimeHooked = false;

    const done = (error) => {
      if (finished) {
        return;
      }
      finished = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const hookRuntimeInit = () => {
      if (!window.cv || runtimeHooked) {
        return;
      }

      runtimeHooked = true;
      const previous = window.cv.onRuntimeInitialized;
      window.cv.onRuntimeInitialized = () => {
        if (typeof previous === "function") {
          previous();
        }
        done();
      };
    };

    const check = () => {
      if (window.cv && typeof window.cv.Mat === "function") {
        done();
        return;
      }

      hookRuntimeInit();
      if (Date.now() - start >= timeoutMs) {
        done(new Error("OpenCV runtime nije spreman."));
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

  setSdkState("Ucitavam OpenCV i photoscan.js...");
  await waitForPhotoScan();
  await waitForOpenCv();
  state.scanner = new window.PhotoScan();
  state.engineReady = true;
  setSdkState("Engine spreman");
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

function detectCorners(source) {
  try {
    const dims = getSourceDimensions(source);
    if (!dims) {
      return null;
    }

    const corners = state.scanner.findReceiptCorners(source);
    if (!corners) {
      return null;
    }

    const metrics = getContourMetrics(corners, dims.width, dims.height);
    if (isLikelyReceiptContour(metrics)) {
      return corners;
    }

    return null;
  } catch (error) {
    return null;
  }
}

function pointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area / 2);
}

function extractDocument(source, corners) {
  const cropped = state.scanner.extractReceipt(source, corners);
  return cropped ? cropped.toDataURL("image/jpeg", 0.92) : null;
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
  state.runningDetection = false;
  clearCameraOverlay();
  setCameraBadge("Neaktivno");
  setActivity("Kamera zaustavljena");
}

async function autoCropCurrentFrame(corners) {
  if (!state.frameCanvas) {
    return;
  }

  refs.originalResult.src = state.frameCanvas.toDataURL("image/jpeg", 0.92);
  const cropDataUrl = extractDocument(state.frameCanvas, corners);
  if (cropDataUrl) {
    refs.croppedResult.src = cropDataUrl;
    setActivity("Auto-crop zavrsen (kamera)");
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
  try {
    const corners = detectCorners(state.frameCanvas);
    if (corners) {
      state.lastCameraCorners = corners;
      drawCameraOverlay();
      setDetection("Dokument pronadjen");

      const points = cornersToArray(corners);
      const areaRatio = polygonArea(points) / (state.frameCanvas.width * state.frameCanvas.height);
      if (areaRatio > 0.14) {
        state.stableFrames += 1;
      } else {
        state.stableFrames = 0;
      }

      if (state.stableFrames >= 4 && Date.now() > state.cooldownUntil) {
        state.cooldownUntil = Date.now() + 2600;
        state.stableFrames = 0;
        setCameraBadge("Auto-crop...");
        await autoCropCurrentFrame(corners);
        window.setTimeout(() => {
          if (state.cameraStream) {
            setCameraBadge("Aktivno");
          }
        }, 900);
      }
    } else {
      state.stableFrames = 0;
      clearCameraOverlay();
      setDetection("Cekam dokument");
    }
  } catch (error) {
    console.error("Camera detection error", error);
    setDetection("Greska detekcije");
  } finally {
    state.runningDetection = false;
  }
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
      video: { facingMode: { ideal: "environment" } },
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
    const corners = detectCorners(image);

    if (!corners) {
      setUploadBadge("Nije nadjen dokument");
      setDetection("Nije detektovano");
      refs.croppedResult.removeAttribute("src");
      clearUploadOverlay();
      return;
    }

    state.lastUploadCorners = corners;
    drawUploadOverlay();
    setUploadBadge("Ivice detektovane");
    setDetection("Dokument pronadjen");

    const cropDataUrl = extractDocument(image, corners);
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
