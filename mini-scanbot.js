(function attachMiniScanbot(globalObject) {
  "use strict";

  const DEFAULT_OPTIONS = Object.freeze({
    waitTimeoutMs: 30000,
    maxDetectionDimension: 1024,
    maxExtractionDimension: 2400,
    minAreaRatio: 0.07,
    fallbackAreaRatio: 0.045,
    minLongShortRatio: 1.14,
    targetAreaRatio: 0.34,
    targetLongShortRatio: 2.2,
    cannyLow: 48,
    cannyHighMultiplier: 2.45,
    approxEpsilonRatio: 0.018,
    minPerimeterPx: 120,
    minConfidence: 0.44,
    enhancedPassBoost: 0.05,
    enhancedCannyScale: 0.82,
    adaptiveBlockSize: 41,
    adaptiveC: 7,
    qrShapeRatioMax: 1.27,
    qrAreaRatioMax: 0.24,
    qrHardRejectShapeRatio: 1.16,
    qrHardRejectAreaRatio: 0.14,
    qrEdgeDensityMin: 0.185,
    defaultJpegQuality: 0.92,
  });

  function mergeOptions(defaults, overrides) {
    return Object.assign({}, defaults, overrides || {});
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getSourceDimensions(source) {
    const width = source?.videoWidth || source?.naturalWidth || source?.width || 0;
    const height = source?.videoHeight || source?.naturalHeight || source?.height || 0;

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }

    return { width, height };
  }

  function pointDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function polygonArea(points) {
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      area += (current.x * next.y) - (next.x * current.y);
    }
    return Math.abs(area / 2);
  }

  function normalizeCorners(points) {
    if (!Array.isArray(points) || points.length !== 4) {
      return null;
    }

    const sums = points.map((point) => point.x + point.y);
    const diffs = points.map((point) => point.x - point.y);

    return {
      topLeft: points[sums.indexOf(Math.min(...sums))],
      topRight: points[diffs.indexOf(Math.max(...diffs))],
      bottomRight: points[sums.indexOf(Math.max(...sums))],
      bottomLeft: points[diffs.indexOf(Math.min(...diffs))],
    };
  }

  function contourToCorners(approx) {
    if (!approx || !approx.data32S || approx.data32S.length !== 8) {
      return null;
    }

    const points = [];
    for (let index = 0; index < approx.data32S.length; index += 2) {
      points.push({
        x: approx.data32S[index],
        y: approx.data32S[index + 1],
      });
    }

    return normalizeCorners(points);
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

  function scaleCorners(corners, scaleX, scaleY) {
    if (!corners) {
      return null;
    }

    return {
      topLeft: { x: corners.topLeft.x * scaleX, y: corners.topLeft.y * scaleY },
      topRight: { x: corners.topRight.x * scaleX, y: corners.topRight.y * scaleY },
      bottomRight: { x: corners.bottomRight.x * scaleX, y: corners.bottomRight.y * scaleY },
      bottomLeft: { x: corners.bottomLeft.x * scaleX, y: corners.bottomLeft.y * scaleY },
    };
  }

  function quadCenter(corners) {
    return {
      x: (corners.topLeft.x + corners.topRight.x + corners.bottomRight.x + corners.bottomLeft.x) / 4,
      y: (corners.topLeft.y + corners.topRight.y + corners.bottomRight.y + corners.bottomLeft.y) / 4,
    };
  }

  function computeRightAngleScore(points) {
    let cosineSum = 0;

    for (let index = 0; index < points.length; index += 1) {
      const previous = points[(index + points.length - 1) % points.length];
      const current = points[index];
      const next = points[(index + 1) % points.length];

      const v1x = previous.x - current.x;
      const v1y = previous.y - current.y;
      const v2x = next.x - current.x;
      const v2y = next.y - current.y;
      const denominator = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);

      if (!denominator) {
        continue;
      }

      const cosine = Math.abs((v1x * v2x + v1y * v2y) / denominator);
      cosineSum += cosine;
    }

    const averageCosine = cosineSum / points.length;
    return 1 - clamp(averageCosine / 0.5, 0, 1);
  }

  function evaluateCorners(corners, frameWidth, frameHeight, options) {
    const points = [
      corners.topLeft,
      corners.topRight,
      corners.bottomRight,
      corners.bottomLeft,
    ];

    const area = polygonArea(points);
    const areaRatio = area / (frameWidth * frameHeight);

    const topWidth = pointDistance(corners.topLeft, corners.topRight);
    const bottomWidth = pointDistance(corners.bottomLeft, corners.bottomRight);
    const leftHeight = pointDistance(corners.topLeft, corners.bottomLeft);
    const rightHeight = pointDistance(corners.topRight, corners.bottomRight);

    const width = Math.max(topWidth, bottomWidth);
    const height = Math.max(leftHeight, rightHeight);
    const shortSide = Math.max(1, Math.min(width, height));
    const longSide = Math.max(width, height);
    const longShortRatio = longSide / shortSide;

    const center = quadCenter(corners);
    const normalizedCenterDx = Math.abs(center.x - (frameWidth / 2)) / (frameWidth / 2);
    const normalizedCenterDy = Math.abs(center.y - (frameHeight / 2)) / (frameHeight / 2);
    const centerScore = 1 - clamp((normalizedCenterDx + normalizedCenterDy) / 2, 0, 1);

    const rightAngleScore = computeRightAngleScore(points);
    const areaDenominator = Math.max(0.01, options.targetAreaRatio - options.minAreaRatio);
    const ratioDenominator = Math.max(0.01, options.targetLongShortRatio - options.minLongShortRatio);

    const areaScore = clamp((areaRatio - options.minAreaRatio) / areaDenominator, 0, 1);
    const ratioScore = clamp((longShortRatio - options.minLongShortRatio) / ratioDenominator, 0, 1);

    const score =
      (areaScore * 0.45) +
      (ratioScore * 0.20) +
      (rightAngleScore * 0.25) +
      (centerScore * 0.10);

    return {
      accepted: areaRatio >= options.minAreaRatio && longShortRatio >= options.minLongShortRatio,
      fallbackAccepted: areaRatio >= options.fallbackAreaRatio,
      score,
      area,
      areaRatio,
      longShortRatio,
    };
  }

  function toClampedPoint(point, frameWidth, frameHeight) {
    return {
      x: Math.round(clamp(point.x, 0, frameWidth - 1)),
      y: Math.round(clamp(point.y, 0, frameHeight - 1)),
    };
  }

  function estimateQuadEdgeDensity(corners, edgeMask, frameWidth, frameHeight) {
    let quadMask;
    let intersection;
    let contour;

    try {
      const topLeft = toClampedPoint(corners.topLeft, frameWidth, frameHeight);
      const topRight = toClampedPoint(corners.topRight, frameWidth, frameHeight);
      const bottomRight = toClampedPoint(corners.bottomRight, frameWidth, frameHeight);
      const bottomLeft = toClampedPoint(corners.bottomLeft, frameWidth, frameHeight);

      contour = globalObject.cv.matFromArray(4, 1, globalObject.cv.CV_32SC2, [
        topLeft.x,
        topLeft.y,
        topRight.x,
        topRight.y,
        bottomRight.x,
        bottomRight.y,
        bottomLeft.x,
        bottomLeft.y,
      ]);

      quadMask = globalObject.cv.Mat.zeros(frameHeight, frameWidth, globalObject.cv.CV_8UC1);
      globalObject.cv.fillConvexPoly(quadMask, contour, new globalObject.cv.Scalar(255), globalObject.cv.LINE_8, 0);

      intersection = new globalObject.cv.Mat();
      globalObject.cv.bitwise_and(edgeMask, quadMask, intersection);

      const regionPixels = Math.max(1, globalObject.cv.countNonZero(quadMask));
      const edgePixels = globalObject.cv.countNonZero(intersection);
      return edgePixels / regionPixels;
    } catch (error) {
      return 0;
    } finally {
      if (quadMask) quadMask.delete();
      if (intersection) intersection.delete();
      if (contour) contour.delete();
    }
  }

  function isLikelyQrOnlyCandidate(corners, metrics, edgeMask, frameWidth, frameHeight, options) {
    if (!metrics) {
      return false;
    }

    if (metrics.longShortRatio > options.qrShapeRatioMax || metrics.areaRatio > options.qrAreaRatioMax) {
      return false;
    }

    if (
      metrics.longShortRatio <= options.qrHardRejectShapeRatio
      && metrics.areaRatio <= options.qrHardRejectAreaRatio
    ) {
      return true;
    }

    const edgeDensity = estimateQuadEdgeDensity(corners, edgeMask, frameWidth, frameHeight);
    return edgeDensity >= options.qrEdgeDensityMin;
  }

  function pickCandidateFromMask(edgeMask, frameWidth, frameHeight, options) {
    let contours;
    let hierarchy;

    try {
      contours = new globalObject.cv.MatVector();
      hierarchy = new globalObject.cv.Mat();

      globalObject.cv.findContours(
        edgeMask,
        contours,
        hierarchy,
        globalObject.cv.RETR_LIST,
        globalObject.cv.CHAIN_APPROX_SIMPLE,
      );

      let bestCandidate = null;
      let bestScore = -Infinity;
      let fallbackCandidate = null;
      let fallbackArea = 0;

      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        const approx = new globalObject.cv.Mat();

        try {
          const contourArea = globalObject.cv.contourArea(contour, false);
          if (contourArea <= 0) {
            continue;
          }

          const perimeter = globalObject.cv.arcLength(contour, true);
          if (perimeter < options.minPerimeterPx) {
            continue;
          }

          globalObject.cv.approxPolyDP(
            contour,
            approx,
            options.approxEpsilonRatio * perimeter,
            true,
          );

          if (approx.rows !== 4 || !globalObject.cv.isContourConvex(approx)) {
            continue;
          }

          const corners = contourToCorners(approx);
          if (!corners) {
            continue;
          }

          const metrics = evaluateCorners(corners, frameWidth, frameHeight, options);
          if (isLikelyQrOnlyCandidate(corners, metrics, edgeMask, frameWidth, frameHeight, options)) {
            continue;
          }

          if (metrics.fallbackAccepted && metrics.area > fallbackArea) {
            fallbackArea = metrics.area;
            fallbackCandidate = {
              corners,
              metrics,
            };
          }

          if (!metrics.accepted) {
            continue;
          }

          const weightedScore =
            (metrics.score * 100) +
            (metrics.areaRatio * 35) +
            (metrics.longShortRatio * 7);

          if (weightedScore > bestScore) {
            bestScore = weightedScore;
            bestCandidate = {
              corners,
              metrics,
            };
          }
        } finally {
          approx.delete();
          contour.delete();
        }
      }

      return {
        bestCandidate,
        fallbackCandidate,
      };
    } finally {
      if (contours) contours.delete();
      if (hierarchy) hierarchy.delete();
    }
  }

  function estimateOutputSize(corners, maxDimension) {
    const width = Math.max(
      pointDistance(corners.topLeft, corners.topRight),
      pointDistance(corners.bottomLeft, corners.bottomRight),
    );

    const height = Math.max(
      pointDistance(corners.topLeft, corners.bottomLeft),
      pointDistance(corners.topRight, corners.bottomRight),
    );

    const baseWidth = Math.max(220, Math.round(width));
    const baseHeight = Math.max(220, Math.round(height));
    const maxSide = Math.max(baseWidth, baseHeight);

    if (maxSide <= maxDimension) {
      return { width: baseWidth, height: baseHeight };
    }

    const ratio = maxDimension / maxSide;
    return {
      width: Math.max(220, Math.round(baseWidth * ratio)),
      height: Math.max(220, Math.round(baseHeight * ratio)),
    };
  }

  function waitForOpenCv(timeoutMs) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let resolved = false;
      let runtimeHooked = false;

      const finish = (error) => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const hookRuntime = () => {
        if (!globalObject.cv || runtimeHooked) {
          return;
        }

        runtimeHooked = true;
        const previous = globalObject.cv.onRuntimeInitialized;
        globalObject.cv.onRuntimeInitialized = () => {
          if (typeof previous === "function") {
            previous();
          }
          finish();
        };
      };

      const check = () => {
        if (globalObject.cv && typeof globalObject.cv.Mat === "function") {
          finish();
          return;
        }

        hookRuntime();
        if ((Date.now() - startedAt) >= timeoutMs) {
          finish(new Error("OpenCV.js runtime nije spreman."));
          return;
        }

        globalObject.setTimeout(check, 50);
      };

      check();
    });
  }

  class MiniScanbot {
    constructor(options) {
      this.options = mergeOptions(DEFAULT_OPTIONS, options);
      this._detectCanvas = globalObject.document.createElement("canvas");
      this._detectContext = this._detectCanvas.getContext("2d", { willReadFrequently: true });
    }

    static async initialize(options) {
      const merged = mergeOptions(DEFAULT_OPTIONS, options);
      await waitForOpenCv(merged.waitTimeoutMs);
      return new MiniScanbot(merged);
    }

    static async create(options) {
      return MiniScanbot.initialize(options);
    }

    destroy() {
      this._detectCanvas.width = 1;
      this._detectCanvas.height = 1;
    }

    detectDocument(source) {
      const sourceDimensions = getSourceDimensions(source);
      if (!sourceDimensions) {
        return null;
      }

      const maxSide = Math.max(sourceDimensions.width, sourceDimensions.height);
      const detectScale =
        maxSide > this.options.maxDetectionDimension
          ? this.options.maxDetectionDimension / maxSide
          : 1;

      const detectWidth = Math.max(240, Math.round(sourceDimensions.width * detectScale));
      const detectHeight = Math.max(240, Math.round(sourceDimensions.height * detectScale));

      this._detectCanvas.width = detectWidth;
      this._detectCanvas.height = detectHeight;
      this._detectContext.drawImage(source, 0, 0, detectWidth, detectHeight);

      let src;
      let gray;
      let blurred;
      let edges;
      let quickMask;
      let equalized;
      let enhancedBlur;
      let enhancedEdges;
      let gradientX;
      let gradientY;
      let absGradientX;
      let absGradientY;
      let gradientMix;
      let gradientMask;
      let adaptiveMask;
      let enhancedMask;
      let kernel;

      try {
        src = globalObject.cv.imread(this._detectCanvas);
        gray = new globalObject.cv.Mat();
        blurred = new globalObject.cv.Mat();
        edges = new globalObject.cv.Mat();
        quickMask = new globalObject.cv.Mat();
        kernel = globalObject.cv.getStructuringElement(
          globalObject.cv.MORPH_RECT,
          new globalObject.cv.Size(3, 3),
        );

        globalObject.cv.cvtColor(src, gray, globalObject.cv.COLOR_RGBA2GRAY, 0);
        globalObject.cv.GaussianBlur(
          gray,
          blurred,
          new globalObject.cv.Size(5, 5),
          0,
          0,
          globalObject.cv.BORDER_DEFAULT,
        );

        const meanBrightness = globalObject.cv.mean(blurred)[0];
        const lowThreshold = clamp(
          this.options.cannyLow + ((meanBrightness - 128) * 0.12),
          35,
          120,
        );
        const highThreshold = Math.max(lowThreshold + 45, lowThreshold * this.options.cannyHighMultiplier);

        globalObject.cv.Canny(blurred, edges, lowThreshold, highThreshold);
        globalObject.cv.morphologyEx(
          edges,
          quickMask,
          globalObject.cv.MORPH_CLOSE,
          kernel,
        );

        const quickSelection = pickCandidateFromMask(
          quickMask,
          detectWidth,
          detectHeight,
          this.options,
        );

        let selected = quickSelection.bestCandidate || quickSelection.fallbackCandidate;

        if (!selected || selected.metrics.score < this.options.minConfidence) {
          equalized = new globalObject.cv.Mat();
          enhancedBlur = new globalObject.cv.Mat();
          enhancedEdges = new globalObject.cv.Mat();
          gradientX = new globalObject.cv.Mat();
          gradientY = new globalObject.cv.Mat();
          absGradientX = new globalObject.cv.Mat();
          absGradientY = new globalObject.cv.Mat();
          gradientMix = new globalObject.cv.Mat();
          gradientMask = new globalObject.cv.Mat();
          adaptiveMask = new globalObject.cv.Mat();
          enhancedMask = new globalObject.cv.Mat();

          globalObject.cv.equalizeHist(gray, equalized);
          globalObject.cv.GaussianBlur(
            equalized,
            enhancedBlur,
            new globalObject.cv.Size(5, 5),
            0,
            0,
            globalObject.cv.BORDER_DEFAULT,
          );

          const enhancedLow = clamp(lowThreshold * this.options.enhancedCannyScale, 24, 105);
          const enhancedHigh = Math.max(enhancedLow + 42, enhancedLow * this.options.cannyHighMultiplier);

          globalObject.cv.Canny(enhancedBlur, enhancedEdges, enhancedLow, enhancedHigh);

          globalObject.cv.Sobel(
            enhancedBlur,
            gradientX,
            globalObject.cv.CV_16S,
            1,
            0,
            3,
            1,
            0,
            globalObject.cv.BORDER_DEFAULT,
          );
          globalObject.cv.Sobel(
            enhancedBlur,
            gradientY,
            globalObject.cv.CV_16S,
            0,
            1,
            3,
            1,
            0,
            globalObject.cv.BORDER_DEFAULT,
          );
          globalObject.cv.convertScaleAbs(gradientX, absGradientX);
          globalObject.cv.convertScaleAbs(gradientY, absGradientY);
          globalObject.cv.addWeighted(absGradientX, 0.5, absGradientY, 0.5, 0, gradientMix);
          globalObject.cv.threshold(
            gradientMix,
            gradientMask,
            0,
            255,
            globalObject.cv.THRESH_BINARY + globalObject.cv.THRESH_OTSU,
          );

          globalObject.cv.adaptiveThreshold(
            enhancedBlur,
            adaptiveMask,
            255,
            globalObject.cv.ADAPTIVE_THRESH_GAUSSIAN_C,
            globalObject.cv.THRESH_BINARY_INV,
            this.options.adaptiveBlockSize,
            this.options.adaptiveC,
          );

          globalObject.cv.bitwise_or(enhancedEdges, gradientMask, enhancedMask);
          globalObject.cv.bitwise_or(enhancedMask, adaptiveMask, enhancedMask);
          globalObject.cv.morphologyEx(
            enhancedMask,
            enhancedMask,
            globalObject.cv.MORPH_CLOSE,
            kernel,
          );
          globalObject.cv.dilate(enhancedMask, enhancedMask, kernel);

          const enhancedSelection = pickCandidateFromMask(
            enhancedMask,
            detectWidth,
            detectHeight,
            this.options,
          );
          const enhancedCandidate = enhancedSelection.bestCandidate || enhancedSelection.fallbackCandidate;

          if (enhancedCandidate) {
            if (!selected) {
              selected = enhancedCandidate;
            } else {
              const baseScore = selected.metrics.score;
              if (
                baseScore < this.options.minConfidence
                || enhancedCandidate.metrics.score >= (baseScore + this.options.enhancedPassBoost)
              ) {
                selected = enhancedCandidate;
              }
            }
          }
        }

        if (!selected) {
          return null;
        }

        const scaleX = sourceDimensions.width / detectWidth;
        const scaleY = sourceDimensions.height / detectHeight;
        const scaledCorners = scaleCorners(selected.corners, scaleX, scaleY);

        return {
          corners: cloneCorners(scaledCorners),
          confidence: clamp(selected.metrics.score, 0, 1),
          areaRatio: selected.metrics.areaRatio,
          longShortRatio: selected.metrics.longShortRatio,
          sourceWidth: sourceDimensions.width,
          sourceHeight: sourceDimensions.height,
        };
      } catch (error) {
        return null;
      } finally {
        if (src) src.delete();
        if (gray) gray.delete();
        if (blurred) blurred.delete();
        if (edges) edges.delete();
        if (quickMask) quickMask.delete();
        if (equalized) equalized.delete();
        if (enhancedBlur) enhancedBlur.delete();
        if (enhancedEdges) enhancedEdges.delete();
        if (gradientX) gradientX.delete();
        if (gradientY) gradientY.delete();
        if (absGradientX) absGradientX.delete();
        if (absGradientY) absGradientY.delete();
        if (gradientMix) gradientMix.delete();
        if (gradientMask) gradientMask.delete();
        if (adaptiveMask) adaptiveMask.delete();
        if (enhancedMask) enhancedMask.delete();
        if (kernel) kernel.delete();
      }
    }

    detect(source) {
      const result = this.detectDocument(source);
      return result ? result.corners : null;
    }

    findReceiptCorners(source) {
      return this.detect(source);
    }

    extractReceipt(source, corners, extractOptions) {
      if (!corners) {
        return null;
      }

      const options = mergeOptions(
        {
          mode: "color",
          jpegQuality: this.options.defaultJpegQuality,
        },
        extractOptions,
      );

      let sourceMat;
      let transform;
      let sourceQuad;
      let destinationQuad;
      let warped;
      let gray;
      let threshold;
      let converted;
      let renderMat;

      try {
        const outputSize = estimateOutputSize(corners, this.options.maxExtractionDimension);
        sourceMat = globalObject.cv.imread(source);

        sourceQuad = globalObject.cv.matFromArray(4, 1, globalObject.cv.CV_32FC2, [
          corners.topLeft.x,
          corners.topLeft.y,
          corners.topRight.x,
          corners.topRight.y,
          corners.bottomRight.x,
          corners.bottomRight.y,
          corners.bottomLeft.x,
          corners.bottomLeft.y,
        ]);

        destinationQuad = globalObject.cv.matFromArray(4, 1, globalObject.cv.CV_32FC2, [
          0,
          0,
          outputSize.width - 1,
          0,
          outputSize.width - 1,
          outputSize.height - 1,
          0,
          outputSize.height - 1,
        ]);

        transform = globalObject.cv.getPerspectiveTransform(sourceQuad, destinationQuad);
        warped = new globalObject.cv.Mat();

        globalObject.cv.warpPerspective(
          sourceMat,
          warped,
          transform,
          new globalObject.cv.Size(outputSize.width, outputSize.height),
          globalObject.cv.INTER_LINEAR,
          globalObject.cv.BORDER_REPLICATE,
          new globalObject.cv.Scalar(),
        );

        renderMat = warped;
        if (options.mode === "gray" || options.mode === "bw") {
          gray = new globalObject.cv.Mat();
          globalObject.cv.cvtColor(warped, gray, globalObject.cv.COLOR_RGBA2GRAY, 0);

          if (options.mode === "bw") {
            threshold = new globalObject.cv.Mat();
            globalObject.cv.adaptiveThreshold(
              gray,
              threshold,
              255,
              globalObject.cv.ADAPTIVE_THRESH_GAUSSIAN_C,
              globalObject.cv.THRESH_BINARY,
              31,
              15,
            );
            converted = new globalObject.cv.Mat();
            globalObject.cv.cvtColor(threshold, converted, globalObject.cv.COLOR_GRAY2RGBA, 0);
          } else {
            converted = new globalObject.cv.Mat();
            globalObject.cv.cvtColor(gray, converted, globalObject.cv.COLOR_GRAY2RGBA, 0);
          }

          renderMat = converted;
        }

        const canvas = globalObject.document.createElement("canvas");
        globalObject.cv.imshow(canvas, renderMat);
        return canvas;
      } catch (error) {
        return null;
      } finally {
        if (sourceMat) sourceMat.delete();
        if (transform) transform.delete();
        if (sourceQuad) sourceQuad.delete();
        if (destinationQuad) destinationQuad.delete();
        if (warped) warped.delete();
        if (gray) gray.delete();
        if (threshold) threshold.delete();
        if (converted) converted.delete();
      }
    }

    crop(source, corners, options) {
      return this.extractReceipt(source, corners, options);
    }

    extractReceiptDataUrl(source, corners, extractOptions) {
      const options = mergeOptions(
        { jpegQuality: this.options.defaultJpegQuality },
        extractOptions,
      );
      const canvas = this.extractReceipt(source, corners, options);
      return canvas ? canvas.toDataURL("image/jpeg", options.jpegQuality) : null;
    }
  }

  globalObject.MiniScanbot = MiniScanbot;
}(typeof globalThis !== "undefined" ? globalThis : window));
