(function attachPhotoScan(windowObject) {
  class PhotoScan {
    constructor() {
      this.cannyLow = 70;
      this.cannyHigh = 190;
    }

    static pointDistance(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    static polygonArea(points) {
      let area = 0;
      for (let i = 0; i < points.length; i += 1) {
        const current = points[i];
        const next = points[(i + 1) % points.length];
        area += current.x * next.y - next.x * current.y;
      }
      return Math.abs(area / 2);
    }

    static getSourceDimensions(source) {
      const width = source?.videoWidth || source?.naturalWidth || source?.width || 0;
      const height = source?.videoHeight || source?.naturalHeight || source?.height || 0;

      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
      }

      return { width, height };
    }

    static normalizeCorners(points) {
      if (!Array.isArray(points) || points.length !== 4) {
        return null;
      }

      const sums = points.map((point) => point.x + point.y);
      const diffs = points.map((point) => point.x - point.y);

      const topLeft = points[sums.indexOf(Math.min(...sums))];
      const bottomRight = points[sums.indexOf(Math.max(...sums))];
      const topRight = points[diffs.indexOf(Math.max(...diffs))];
      const bottomLeft = points[diffs.indexOf(Math.min(...diffs))];

      return {
        topLeft,
        topRight,
        bottomRight,
        bottomLeft,
      };
    }

    static contourToCorners(contour) {
      if (!contour || !contour.data32S || contour.data32S.length < 8) {
        return null;
      }

      const points = [];
      for (let i = 0; i < contour.data32S.length; i += 2) {
        points.push({
          x: contour.data32S[i],
          y: contour.data32S[i + 1],
        });
      }

      return PhotoScan.normalizeCorners(points);
    }

    static contourMetrics(corners, sourceWidth, sourceHeight) {
      const points = [
        corners.topLeft,
        corners.topRight,
        corners.bottomRight,
        corners.bottomLeft,
      ];

      const topWidth = PhotoScan.pointDistance(corners.topLeft, corners.topRight);
      const bottomWidth = PhotoScan.pointDistance(corners.bottomLeft, corners.bottomRight);
      const leftHeight = PhotoScan.pointDistance(corners.topLeft, corners.bottomLeft);
      const rightHeight = PhotoScan.pointDistance(corners.topRight, corners.bottomRight);
      const width = Math.max(topWidth, bottomWidth);
      const height = Math.max(leftHeight, rightHeight);
      const shorter = Math.max(1, Math.min(width, height));
      const longer = Math.max(width, height);

      return {
        area: PhotoScan.polygonArea(points),
        areaRatio: PhotoScan.polygonArea(points) / (sourceWidth * sourceHeight),
        longShortRatio: longer / shorter,
      };
    }

    static estimateExtractionSize(corners) {
      const width = Math.max(
        PhotoScan.pointDistance(corners.topLeft, corners.topRight),
        PhotoScan.pointDistance(corners.bottomLeft, corners.bottomRight),
      );

      const height = Math.max(
        PhotoScan.pointDistance(corners.topLeft, corners.bottomLeft),
        PhotoScan.pointDistance(corners.topRight, corners.bottomRight),
      );

      return {
        width: Math.max(180, Math.round(width)),
        height: Math.max(180, Math.round(height)),
      };
    }

    findReceiptCorners(source) {
      const dimensions = PhotoScan.getSourceDimensions(source);
      if (!dimensions) {
        return null;
      }

      let src;
      let gray;
      let blurred;
      let edges;
      let kernel;
      let contours;
      let hierarchy;

      try {
        src = windowObject.cv.imread(source);
        gray = new windowObject.cv.Mat();
        blurred = new windowObject.cv.Mat();
        edges = new windowObject.cv.Mat();
        kernel = windowObject.cv.getStructuringElement(windowObject.cv.MORPH_RECT, new windowObject.cv.Size(3, 3));
        contours = new windowObject.cv.MatVector();
        hierarchy = new windowObject.cv.Mat();

        windowObject.cv.cvtColor(src, gray, windowObject.cv.COLOR_RGBA2GRAY, 0);
        windowObject.cv.GaussianBlur(gray, blurred, new windowObject.cv.Size(5, 5), 0, 0, windowObject.cv.BORDER_DEFAULT);
        windowObject.cv.Canny(blurred, edges, this.cannyLow, this.cannyHigh);
        windowObject.cv.dilate(edges, edges, kernel);
        windowObject.cv.findContours(
          edges,
          contours,
          hierarchy,
          windowObject.cv.RETR_LIST,
          windowObject.cv.CHAIN_APPROX_SIMPLE,
        );

        let bestReceipt = null;
        let bestReceiptScore = -Infinity;
        let bestFallback = null;
        let bestFallbackArea = 0;

        for (let i = 0; i < contours.size(); i += 1) {
          const contour = contours.get(i);
          const perimeter = windowObject.cv.arcLength(contour, true);
          const approx = new windowObject.cv.Mat();

          try {
            if (perimeter <= 0) {
              continue;
            }

            windowObject.cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);
            if (approx.rows !== 4 || !windowObject.cv.isContourConvex(approx)) {
              continue;
            }

            const corners = PhotoScan.contourToCorners(approx);
            if (!corners) {
              continue;
            }

            const metrics = PhotoScan.contourMetrics(corners, dimensions.width, dimensions.height);
            if (!metrics) {
              continue;
            }

            if (metrics.areaRatio > 0.06 && metrics.area > bestFallbackArea) {
              bestFallbackArea = metrics.area;
              bestFallback = corners;
            }

            // Prefer larger and elongated contours to avoid selecting QR blocks.
            if (metrics.areaRatio < 0.085 || metrics.longShortRatio < 1.18) {
              continue;
            }

            const score = (metrics.areaRatio * 1000) + (metrics.longShortRatio * 45);
            if (score > bestReceiptScore) {
              bestReceiptScore = score;
              bestReceipt = corners;
            }
          } finally {
            approx.delete();
            contour.delete();
          }
        }

        return bestReceipt || bestFallback;
      } catch (error) {
        return null;
      } finally {
        if (src) src.delete();
        if (gray) gray.delete();
        if (blurred) blurred.delete();
        if (edges) edges.delete();
        if (kernel) kernel.delete();
        if (contours) contours.delete();
        if (hierarchy) hierarchy.delete();
      }
    }

    extractReceipt(source, corners) {
      if (!corners) {
        return null;
      }

      const outputSize = PhotoScan.estimateExtractionSize(corners);

      let src;
      let srcTri;
      let dstTri;
      let transform;
      let dst;

      try {
        src = windowObject.cv.imread(source);
        srcTri = windowObject.cv.matFromArray(4, 1, windowObject.cv.CV_32FC2, [
          corners.topLeft.x,
          corners.topLeft.y,
          corners.topRight.x,
          corners.topRight.y,
          corners.bottomRight.x,
          corners.bottomRight.y,
          corners.bottomLeft.x,
          corners.bottomLeft.y,
        ]);

        dstTri = windowObject.cv.matFromArray(4, 1, windowObject.cv.CV_32FC2, [
          0,
          0,
          outputSize.width - 1,
          0,
          outputSize.width - 1,
          outputSize.height - 1,
          0,
          outputSize.height - 1,
        ]);

        transform = windowObject.cv.getPerspectiveTransform(srcTri, dstTri);
        dst = new windowObject.cv.Mat();
        windowObject.cv.warpPerspective(
          src,
          dst,
          transform,
          new windowObject.cv.Size(outputSize.width, outputSize.height),
          windowObject.cv.INTER_LINEAR,
          windowObject.cv.BORDER_CONSTANT,
          new windowObject.cv.Scalar(),
        );

        const canvas = document.createElement("canvas");
        windowObject.cv.imshow(canvas, dst);
        return canvas;
      } catch (error) {
        return null;
      } finally {
        if (src) src.delete();
        if (srcTri) srcTri.delete();
        if (dstTri) dstTri.delete();
        if (transform) transform.delete();
        if (dst) dst.delete();
      }
    }
  }

  windowObject.PhotoScan = PhotoScan;
}(window));
