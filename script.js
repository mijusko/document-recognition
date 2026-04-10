const WORKER_URL = "./detector.worker.js";

const state = {
	worker: null,
	workerReady: false,
	pendingDetections: new Map(),
	workerRequestSeq: 1,
	activeMode: "upload",
	cameraStream: null,
	cameraLoopId: null,
	detectionInFlight: false,
	lastCameraDetectionAt: 0,
	cameraDetectionInterval: 135,
	lastDetectionDurationMs: 0,
	smoothedCameraCorners: null,
	lastCameraResult: null,
	lastUploadResult: null,
	uploadObjectUrl: null,
	pendingUploadDetection: false,
	uploadImageLoaded: false,
	missingContourFrames: 0,
	maxMissingContourFrames: 12,
};

const refs = {
	fileInput: document.querySelector("#fileInput"),
	fileMeta: document.querySelector("#fileMeta"),
	cameraToggle: document.querySelector("#cameraToggle"),
	cameraHint: document.querySelector("#cameraHint"),
	uploadPreview: document.querySelector("#uploadPreview"),
	cameraPreview: document.querySelector("#cameraPreview"),
	uploadOverlay: document.querySelector("#uploadOverlay"),
	cameraOverlay: document.querySelector("#cameraOverlay"),
	uploadFrame: document.querySelector("#uploadFrame"),
	cameraFrame: document.querySelector("#cameraFrame"),
	uploadPlaceholder: document.querySelector("#uploadPlaceholder"),
	cameraPlaceholder: document.querySelector("#cameraPlaceholder"),
	uploadStage: document.querySelector("#uploadStage"),
	cameraStage: document.querySelector("#cameraStage"),
	engineState: document.querySelector("#engineState"),
	detectionState: document.querySelector("#detectionState"),
	confidenceState: document.querySelector("#confidenceState"),
	activeModeLabel: document.querySelector("#activeModeLabel"),
	frameSizeLabel: document.querySelector("#frameSizeLabel"),
	cornersLabel: document.querySelector("#cornersLabel"),
	areaLabel: document.querySelector("#areaLabel"),
	liveBadge: document.querySelector("#liveBadge"),
	analysisCanvas: document.querySelector("#analysisCanvas"),
	modeButtons: [...document.querySelectorAll(".mode-button")],
	uploadPane: document.querySelector("#uploadPane"),
	cameraPane: document.querySelector("#cameraPane"),
};

function setEngineState(message) {
	refs.engineState.textContent = message;
}

function setDetectionState(message) {
	refs.detectionState.textContent = message;
}

function setConfidence(value) {
	refs.confidenceState.textContent = value;
}

function setInsightValues({ mode, frameWidth, frameHeight, corners, areaRatio }) {
	refs.activeModeLabel.textContent = mode === "camera" ? "Kamera" : "Slika";
	refs.frameSizeLabel.textContent = frameWidth && frameHeight ? `${frameWidth} x ${frameHeight}` : "-";
	refs.cornersLabel.textContent = Array.isArray(corners) && corners.length ? `${corners.length} / 4` : "-";
	refs.areaLabel.textContent = areaRatio ? `${Math.round(areaRatio * 100)}% kadra` : "-";
}

function setMode(mode) {
	if (mode === "upload" && state.cameraStream) {
		stopCamera();
	}

	state.activeMode = mode;
	refs.modeButtons.forEach((button) => {
		button.classList.toggle("is-active", button.dataset.mode === mode);
	});

	refs.uploadPane.classList.toggle("is-hidden", mode !== "upload");
	refs.cameraPane.classList.toggle("is-hidden", mode !== "camera");
	refs.uploadStage.classList.toggle("is-active", mode === "upload");
	refs.cameraStage.classList.toggle("is-active", mode === "camera");
	refs.liveBadge.textContent = mode === "camera" ? "Live kamera" : "Upload rezim";

	if (mode === "upload") {
		setInsightValues({
			mode,
			frameWidth: state.lastUploadResult?.frame_width,
			frameHeight: state.lastUploadResult?.frame_height,
			corners: state.lastUploadResult?.corners,
			areaRatio: state.lastUploadResult?.area_ratio,
		});
		redrawUploadOverlay();
		return;
	}

	setInsightValues({
		mode,
		frameWidth: state.lastCameraResult?.frame_width,
		frameHeight: state.lastCameraResult?.frame_height,
		corners: state.lastCameraResult?.corners,
		areaRatio: state.lastCameraResult?.area_ratio,
	});

	if (!state.cameraStream) {
		setDetectionState("Ukljuci kameru za live detekciju");
		setConfidence("-");
	}

	redrawCameraOverlay();
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

function setupCanvasForFrame(canvas, frame) {
	const bounds = frame.getBoundingClientRect();
	const ratio = window.devicePixelRatio || 1;
	canvas.width = Math.max(1, Math.round(bounds.width * ratio));
	canvas.height = Math.max(1, Math.round(bounds.height * ratio));
	const context = canvas.getContext("2d");
	context.setTransform(ratio, 0, 0, ratio, 0, 0);
	context.clearRect(0, 0, bounds.width, bounds.height);
	return { context, width: bounds.width, height: bounds.height };
}

function drawCorners({ canvas, frame, frameWidth, frameHeight, corners, hold }) {
	const { context, width, height } = setupCanvasForFrame(canvas, frame);
	if (!Array.isArray(corners) || corners.length !== 4) {
		return;
	}

	const mediaRect = getContainRect(frameWidth, frameHeight, width, height);
	const scaled = corners.map(([x, y]) => ({
		x: mediaRect.x + (x / frameWidth) * mediaRect.width,
		y: mediaRect.y + (y / frameHeight) * mediaRect.height,
	}));

	context.save();
	context.lineJoin = "round";
	context.lineCap = "round";
	context.strokeStyle = hold ? "rgba(104, 240, 178, 0.52)" : "rgba(104, 240, 178, 0.98)";
	context.fillStyle = hold ? "rgba(104, 240, 178, 0.08)" : "rgba(104, 240, 178, 0.12)";
	context.lineWidth = hold ? 3 : 4;
	context.shadowColor = "rgba(104, 240, 178, 0.4)";
	context.shadowBlur = hold ? 8 : 16;

	context.beginPath();
	scaled.forEach((point, index) => {
		if (index === 0) {
			context.moveTo(point.x, point.y);
			return;
		}
		context.lineTo(point.x, point.y);
	});
	context.closePath();
	context.fill();
	context.stroke();

	scaled.forEach((point, index) => {
		context.beginPath();
		context.fillStyle = index === 0 ? "rgba(212, 107, 41, 0.95)" : "rgba(255, 248, 239, 0.95)";
		context.arc(point.x, point.y, hold ? 4 : 5, 0, Math.PI * 2);
		context.fill();
	});

	context.restore();
}

function redrawUploadOverlay() {
	if (!state.lastUploadResult?.found) {
		const canvas = refs.uploadOverlay;
		const { context } = setupCanvasForFrame(canvas, refs.uploadFrame);
		context.clearRect(0, 0, canvas.width, canvas.height);
		return;
	}

	drawCorners({
		canvas: refs.uploadOverlay,
		frame: refs.uploadFrame,
		frameWidth: state.lastUploadResult.frame_width,
		frameHeight: state.lastUploadResult.frame_height,
		corners: state.lastUploadResult.corners,
		hold: false,
	});
}

function redrawCameraOverlay({ hold = false } = {}) {
	const result = state.lastCameraResult;
	if (!result?.corners?.length) {
		const canvas = refs.cameraOverlay;
		const { context } = setupCanvasForFrame(canvas, refs.cameraFrame);
		context.clearRect(0, 0, canvas.width, canvas.height);
		return;
	}

	drawCorners({
		canvas: refs.cameraOverlay,
		frame: refs.cameraFrame,
		frameWidth: result.frame_width,
		frameHeight: result.frame_height,
		corners: result.corners,
		hold,
	});
}

function normalizeCorners(corners) {
	return corners.map(([x, y]) => [Number(x), Number(y)]);
}

function clipCorners(corners, width, height) {
	return corners.map(([x, y]) => [
		Math.max(0, Math.min(width - 1, x)),
		Math.max(0, Math.min(height - 1, y)),
	]);
}

function polygonArea(corners) {
	if (!Array.isArray(corners) || corners.length !== 4) {
		return 0;
	}

	let area = 0;
	for (let i = 0; i < 4; i += 1) {
		const j = (i + 1) % 4;
		area += (corners[i][0] * corners[j][1]) - (corners[j][0] * corners[i][1]);
	}
	return Math.abs(area) * 0.5;
}

function isValidDocumentDetection(corners, imgW, imgH) {
	if (!Array.isArray(corners) || corners.length !== 4 || !imgW || !imgH) {
		return false;
	}

	const area = polygonArea(corners);
	const totalArea = imgW * imgH;
	if (area < totalArea * 0.07 || area > totalArea * 0.98) {
		return false;
	}

	const xs = corners.map((point) => point[0]);
	const ys = corners.map((point) => point[1]);
	const bboxW = Math.max(...xs) - Math.min(...xs);
	const bboxH = Math.max(...ys) - Math.min(...ys);
	const aspectRatio = bboxW / Math.max(1, bboxH);

	if (aspectRatio > 0.72 && aspectRatio < 1.42 && area < totalArea * 0.22) {
		return false;
	}

	const sideLengths = corners.map((point, index) => {
		const next = corners[(index + 1) % 4];
		return Math.hypot(next[0] - point[0], next[1] - point[1]);
	});
	const minSide = Math.min(...sideLengths);
	const maxSide = Math.max(...sideLengths);
	if (minSide < Math.hypot(imgW, imgH) * 0.08 || maxSide / Math.max(minSide, 1) > 12) {
		return false;
	}

	return true;
}

function expandCornersOutward(corners, amountPx, frameW, frameH) {
	if (!Array.isArray(corners) || corners.length !== 4) {
		return corners;
	}

	const centerX = corners.reduce((acc, [x]) => acc + x, 0) / 4;
	const centerY = corners.reduce((acc, [, y]) => acc + y, 0) / 4;

	const expanded = corners.map(([x, y]) => {
		const dx = x - centerX;
		const dy = y - centerY;
		const length = Math.hypot(dx, dy) || 1;
		return [
			x + ((dx / length) * amountPx),
			y + ((dy / length) * amountPx),
		];
	});

	return clipCorners(expanded, frameW, frameH);
}

function quadAverageDistance(cornersA, cornersB) {
	if (!Array.isArray(cornersA) || !Array.isArray(cornersB) || cornersA.length !== 4 || cornersB.length !== 4) {
		return Number.POSITIVE_INFINITY;
	}

	return cornersA.reduce((total, [ax, ay], index) => {
		const [bx, by] = cornersB[index];
		return total + Math.hypot(ax - bx, ay - by);
	}, 0) / 4;
}

function pickBetterDetection(baseResult, nextResult) {
	if (!baseResult) {
		return nextResult;
	}
	if (!nextResult) {
		return baseResult;
	}

	if (nextResult.found && !baseResult.found) {
		return nextResult;
	}
	if (baseResult.found && !nextResult.found) {
		return baseResult;
	}

	const baseConfidence = Number(baseResult.confidence || 0);
	const nextConfidence = Number(nextResult.confidence || 0);
	if (nextConfidence > baseConfidence + 0.03) {
		return nextResult;
	}

	const baseArea = Number(baseResult.area_ratio || 0);
	const nextArea = Number(nextResult.area_ratio || 0);
	if (Math.abs(nextConfidence - baseConfidence) <= 0.03 && nextArea > baseArea + 0.03) {
		return nextResult;
	}

	return baseResult;
}

function smoothCameraCorners(nextCorners, frameWidth, frameHeight) {
	if (!Array.isArray(nextCorners) || nextCorners.length !== 4) {
		return null;
	}

	if (!Array.isArray(state.smoothedCameraCorners) || state.smoothedCameraCorners.length !== 4) {
		state.smoothedCameraCorners = normalizeCorners(nextCorners);
		return state.smoothedCameraCorners;
	}

	const maxJump = Math.max(frameWidth, frameHeight) * 0.22;
	const jump = nextCorners.reduce((total, [x, y], index) => {
		const [prevX, prevY] = state.smoothedCameraCorners[index];
		return total + Math.hypot(x - prevX, y - prevY);
	}, 0) / nextCorners.length;

	if (jump > maxJump) {
		state.smoothedCameraCorners = normalizeCorners(nextCorners);
		return state.smoothedCameraCorners;
	}

	const alpha = 0.36;
	state.smoothedCameraCorners = state.smoothedCameraCorners.map(([prevX, prevY], index) => {
		const [nextX, nextY] = nextCorners[index];
		return [
			prevX + ((nextX - prevX) * alpha),
			prevY + ((nextY - prevY) * alpha),
		];
	});

	return state.smoothedCameraCorners;
}

function updateDetectionUI(result, mode) {
	if (result?.found) {
		if (mode === "camera") {
			if (result.confidence >= 0.76) {
				setDetectionState("Dokument je stabilno detektovan");
			} else if (result.confidence >= 0.58) {
				setDetectionState("Dokument je pronadjen, zadrzi kadar mirno");
			} else {
				setDetectionState("Dokument je detektovan, poboljsavam stabilnost");
			}
		} else {
			setDetectionState("Dokument je pronadjen na slici");
		}
		setConfidence(`${Math.round(result.confidence * 100)}%`);
	} else {
		setDetectionState(mode === "camera" ? "Trazi dokument u live kadru" : "Dokument nije dovoljno jasno izdvojen");
		setConfidence("-");
	}

	setInsightValues({
		mode,
		frameWidth: result?.frame_width,
		frameHeight: result?.frame_height,
		corners: result?.corners,
		areaRatio: result?.area_ratio,
	});
}

function getSourceDimensions(source) {
	if (source instanceof HTMLVideoElement) {
		return { width: source.videoWidth, height: source.videoHeight };
	}
	return { width: source.naturalWidth, height: source.naturalHeight };
}

function sampleToAnalysisCanvas(source, mode, forcedMaxDimension = null) {
	const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(source);
	const maxDimension = forcedMaxDimension ?? (mode === "camera" ? 620 : 1200);
	const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
	const frameWidth = Math.max(1, Math.round(sourceWidth * scale));
	const frameHeight = Math.max(1, Math.round(sourceHeight * scale));

	refs.analysisCanvas.width = frameWidth;
	refs.analysisCanvas.height = frameHeight;
	const context = refs.analysisCanvas.getContext("2d", { willReadFrequently: true });
	context.drawImage(source, 0, 0, frameWidth, frameHeight);
	return context.getImageData(0, 0, frameWidth, frameHeight);
}

function setupDetectorWorker() {
	if (state.worker) {
		return;
	}

	setEngineState("Pokrecem Python worker...");
	const worker = new Worker(WORKER_URL);
	state.worker = worker;

	worker.onmessage = (event) => {
		const message = event.data;
		if (!message || typeof message !== "object") {
			return;
		}

		if (message.type === "status") {
			setEngineState(String(message.message || "Python worker radi..."));
			return;
		}

		if (message.type === "ready") {
			state.workerReady = true;
			setEngineState("Python worker je spreman");
			if (state.pendingUploadDetection) {
				void processUploadImage();
			}
			if (state.cameraStream) {
				startCameraLoop();
			}
			return;
		}

		if (message.type === "result") {
			const pending = state.pendingDetections.get(message.id);
			if (!pending) {
				return;
			}
			clearTimeout(pending.timeoutId);
			state.pendingDetections.delete(message.id);
			pending.resolve(message.result || null);
			return;
		}

		if (message.type === "error") {
			const pending = state.pendingDetections.get(message.id);
			if (!pending) {
				setDetectionState("Greska u Python detektoru");
				return;
			}
			clearTimeout(pending.timeoutId);
			state.pendingDetections.delete(message.id);
			pending.reject(new Error(message.error || "Unknown worker error"));
		}
	};

	worker.onerror = (error) => {
		console.error(error);
		setEngineState("Python worker nije uspesno pokrenut");
		setDetectionState("Proveri internet konekciju i osvezi stranicu");
	};
}

function requestWorkerDetection(imageData, mode) {
	if (!state.workerReady || !state.worker) {
		return Promise.resolve(null);
	}

	const id = state.workerRequestSeq;
	state.workerRequestSeq += 1;

	return new Promise((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			state.pendingDetections.delete(id);
			reject(new Error("Python detection timeout"));
		}, 10000);

		state.pendingDetections.set(id, { resolve, reject, timeoutId });

		const pixels = imageData.data.buffer;
		state.worker.postMessage({
			type: "detect",
			id,
			mode,
			width: imageData.width,
			height: imageData.height,
			pixels,
		}, [pixels]);
	});
}

async function detectDocument(imageData, mode) {
	const result = await requestWorkerDetection(imageData, mode);
	if (!result) {
		return null;
	}

	if (!result.found || !Array.isArray(result.corners) || result.corners.length !== 4) {
		result.corners = [];
		return result;
	}

	result.corners = normalizeCorners(result.corners);
	if (!isValidDocumentDetection(result.corners, result.frame_width, result.frame_height)) {
		result.found = false;
		result.corners = [];
		result.confidence = Math.min(Number(result.confidence || 0), 0.22);
		return result;
	}

	const expandPx = Math.max(6, Math.round(Math.min(result.frame_width, result.frame_height) * 0.008));
	result.corners = expandCornersOutward(result.corners, expandPx, result.frame_width, result.frame_height);
	return result;
}

async function processUploadImage() {
	if (!state.uploadImageLoaded) {
		return;
	}

	if (!state.workerReady) {
		state.pendingUploadDetection = true;
		setDetectionState("Python worker se i dalje ucitava");
		return;
	}

	if (state.detectionInFlight) {
		return;
	}

	state.detectionInFlight = true;
	setDetectionState("Analiziram uploadovanu sliku...");

	try {
		const firstPass = sampleToAnalysisCanvas(refs.uploadPreview, "upload", 1180);
		let result = await detectDocument(firstPass, "upload");

		const shouldRefine = !result?.found || Number(result.confidence || 0) < 0.68;
		if (shouldRefine) {
			setDetectionState("Radim dodatni precizni prolaz...");
			const secondPass = sampleToAnalysisCanvas(refs.uploadPreview, "upload", 1620);
			const refined = await detectDocument(secondPass, "upload");
			result = pickBetterDetection(result, refined);
		}

		state.lastUploadResult = result;
		updateDetectionUI(result, "upload");
		redrawUploadOverlay();
	} catch (error) {
		console.error(error);
		setDetectionState("Doslo je do greske pri obradi slike");
		setConfidence("-");
	} finally {
		state.pendingUploadDetection = false;
		state.detectionInFlight = false;
	}
}

function handleUploadSelection(file) {
	if (!file) {
		return;
	}

	if (state.uploadObjectUrl) {
		URL.revokeObjectURL(state.uploadObjectUrl);
	}

	state.uploadImageLoaded = false;
	state.lastUploadResult = null;
	const objectUrl = URL.createObjectURL(file);
	state.uploadObjectUrl = objectUrl;
	refs.fileMeta.textContent = `${file.name} • ${(file.size / 1024 / 1024).toFixed(2)} MB`;
	refs.uploadPlaceholder.style.display = "none";
	refs.uploadPreview.classList.add("is-visible");
	refs.uploadPreview.onload = () => {
		state.uploadImageLoaded = true;
		void processUploadImage();
	};
	refs.uploadPreview.src = objectUrl;
}

function resetCameraTracking() {
	state.smoothedCameraCorners = null;
	state.lastCameraResult = null;
	state.lastCameraDetectionAt = 0;
	state.lastDetectionDurationMs = 0;
	state.cameraDetectionInterval = 135;
	state.missingContourFrames = 0;
}

async function startCamera() {
	if (!navigator.mediaDevices?.getUserMedia) {
		refs.cameraHint.textContent = "Ovaj browser ne podrzava pristup kameri.";
		return;
	}

	try {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {
				facingMode: { ideal: "environment" },
				width: { ideal: 1920 },
				height: { ideal: 1080 },
			},
		});

		state.cameraStream = stream;
		resetCameraTracking();
		refs.cameraPreview.srcObject = stream;
		refs.cameraPreview.classList.remove("is-hidden");
		refs.cameraPlaceholder.style.display = "none";
		refs.cameraToggle.textContent = "Zaustavi kameru";
		refs.cameraHint.textContent = "Kamera je aktivna. Drzi dokument ceo u kadru za najbolji rezultat.";

		await refs.cameraPreview.play();
		if (state.workerReady) {
			startCameraLoop();
		} else {
			setDetectionState("Kamera radi, Python worker se jos ucitava");
		}
	} catch (error) {
		console.error(error);
		refs.cameraHint.textContent = "Pristup kameri nije dozvoljen ili nije dostupan na ovoj adresi.";
	}
}

function stopCamera() {
	if (state.cameraLoopId) {
		cancelAnimationFrame(state.cameraLoopId);
		state.cameraLoopId = null;
	}

	if (state.cameraStream) {
		state.cameraStream.getTracks().forEach((track) => track.stop());
		state.cameraStream = null;
	}

	resetCameraTracking();
	refs.cameraPreview.pause();
	refs.cameraPreview.srcObject = null;
	refs.cameraPreview.classList.add("is-hidden");
	refs.cameraPlaceholder.style.display = "grid";
	refs.cameraToggle.textContent = "Pokreni kameru";
	refs.cameraHint.textContent = "Kamera radi na localhost ili https adresi. Najbolji rezultat je kada je list ceo u kadru i bez jakih senki.";
	redrawCameraOverlay();

	if (state.activeMode === "camera") {
		setDetectionState("Kamera je zaustavljena");
		setConfidence("-");
		setInsightValues({ mode: "camera" });
	}
}

async function performCameraDetection() {
	if (!state.cameraStream || !state.workerReady || state.detectionInFlight) {
		return;
	}

	if (refs.cameraPreview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
		return;
	}

	state.detectionInFlight = true;
	const startedAt = performance.now();

	try {
		const imageData = sampleToAnalysisCanvas(refs.cameraPreview, "camera", 620);
		const result = await detectDocument(imageData, "camera");

		if (result?.found) {
			const smoothedCorners = smoothCameraCorners(result.corners, result.frame_width, result.frame_height);
			const previousCorners = state.lastCameraResult?.corners;
			if (Array.isArray(previousCorners) && previousCorners.length === 4) {
				const drift = quadAverageDistance(smoothedCorners, previousCorners);
				const maxDrift = Math.max(result.frame_width, result.frame_height) * 0.24;
				const previousConfidence = Number(state.lastCameraResult?.confidence || 0);
				if (drift > maxDrift && Number(result.confidence || 0) < previousConfidence + 0.06) {
					state.missingContourFrames += 1;
					redrawCameraOverlay({ hold: true });
					setDetectionState("Stabilizujem konturu dokumenta...");
					setConfidence(`${Math.round(previousConfidence * 100)}%`);
					return;
				}
			}

			result.corners = smoothedCorners;
			state.lastCameraResult = result;
			state.missingContourFrames = 0;
			updateDetectionUI(result, "camera");
			redrawCameraOverlay();
			return;
		}

		state.missingContourFrames += 1;
		if (state.lastCameraResult?.corners?.length && state.missingContourFrames <= state.maxMissingContourFrames) {
			redrawCameraOverlay({ hold: true });
			setDetectionState("Dokument kratko izlazi iz kadra");
			setConfidence(`${Math.round((state.lastCameraResult.confidence || 0) * 100)}%`);
			return;
		}

		state.smoothedCameraCorners = null;
		state.lastCameraResult = result;
		updateDetectionUI(result, "camera");
		redrawCameraOverlay();
	} catch (error) {
		console.error(error);
		setDetectionState("Greska tokom live detekcije");
		setConfidence("-");
	} finally {
		state.lastDetectionDurationMs = performance.now() - startedAt;
		state.cameraDetectionInterval = Math.min(260, Math.max(100, state.lastDetectionDurationMs * 1.2));
		state.detectionInFlight = false;
	}
}

function startCameraLoop() {
	if (state.cameraLoopId) {
		cancelAnimationFrame(state.cameraLoopId);
	}

	const loop = (timestamp) => {
		state.cameraLoopId = requestAnimationFrame(loop);
		if (!state.cameraStream) {
			return;
		}

		if (timestamp - state.lastCameraDetectionAt < state.cameraDetectionInterval) {
			return;
		}

		state.lastCameraDetectionAt = timestamp;
		void performCameraDetection();
	};

	state.cameraLoopId = requestAnimationFrame(loop);
}

function bindEvents() {
	refs.modeButtons.forEach((button) => {
		button.addEventListener("click", () => setMode(button.dataset.mode));
	});

	refs.fileInput.addEventListener("change", (event) => {
		const [file] = event.target.files || [];
		handleUploadSelection(file);
	});

	refs.cameraToggle.addEventListener("click", async () => {
		if (state.cameraStream) {
			stopCamera();
			return;
		}
		await startCamera();
	});

	window.addEventListener("resize", () => {
		redrawUploadOverlay();
		redrawCameraOverlay();
	});

	window.addEventListener("beforeunload", () => {
		if (state.uploadObjectUrl) {
			URL.revokeObjectURL(state.uploadObjectUrl);
		}
		stopCamera();
		if (state.worker) {
			state.worker.terminate();
			state.worker = null;
		}
	});
}

function init() {
	bindEvents();
	setMode("upload");
	setupDetectorWorker();
}

init();
