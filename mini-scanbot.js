/**
 * MiniScanbot — lokalna zamena za Scanbot SDK.
 * Oslanja se na photoscan.js (OpenCV.js) engine ispod haube i
 * izlaze isti API oblik koji bi imao komercijalni Scanbot SDK:
 *   - MiniScanbot.create(options?)
 *   - scanner.detect(source)            → corners | null
 *   - scanner.crop(source, corners)     → HTMLCanvasElement | null
 *   - scanner.findReceiptCorners(source) → corners | null   (alias)
 *   - scanner.extractReceipt(source, corners) → canvas | null (alias)
 */
(function (global) {
  "use strict";

  // ─── Defaults ─────────────────────────────────────────────────────────────
  var DEFAULT_OPTIONS = {
    /** Minimum area as a fraction of total image area (0–1). */
    minAreaRatio: 0.085,
    /** Minimum long-to-short side ratio — suppresses square/QR detections. */
    minLongShortRatio: 1.18,
    /** JPEG quality for toDataURL calls. */
    jpegQuality: 0.92,
  };

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function mergeOptions(defaults, overrides) {
    var result = {};
    for (var key in defaults) {
      result[key] = defaults[key];
    }
    if (overrides && typeof overrides === "object") {
      for (var k in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, k)) {
          result[k] = overrides[k];
        }
      }
    }
    return result;
  }

  // ─── MiniScanbot class ────────────────────────────────────────────────────
  function MiniScanbot(options) {
    if (!(this instanceof MiniScanbot)) {
      return new MiniScanbot(options);
    }

    this.options = mergeOptions(DEFAULT_OPTIONS, options);

    if (typeof global.PhotoScan !== "function") {
      throw new Error(
        "[MiniScanbot] PhotoScan engine nije dostupan. " +
        "Uveri se da je photoscan.js ucitan pre mini-scanbot.js."
      );
    }

    this._engine = new global.PhotoScan();
  }

  /**
   * Factory method — preferred way to create an instance.
   * @param {object} [options]
   * @returns {MiniScanbot}
   */
  MiniScanbot.create = function (options) {
    return new MiniScanbot(options);
  };

  /**
   * Detect document corners in a given source.
   *
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} source
   * @returns {{ topLeft, topRight, bottomRight, bottomLeft } | null}
   */
  MiniScanbot.prototype.detect = function (source) {
    try {
      var corners = this._engine.findReceiptCorners(source);
      if (!corners) return null;

      // Apply configured heuristics on top of engine result
      var area = _polygonArea([
        corners.topLeft, corners.topRight,
        corners.bottomRight, corners.bottomLeft,
      ]);

      var w = source.videoWidth || source.naturalWidth || source.width || 0;
      var h = source.videoHeight || source.naturalHeight || source.height || 0;
      if (!w || !h) return corners; // can't validate, trust the engine

      var areaRatio = area / (w * h);
      if (areaRatio < this.options.minAreaRatio) return null;

      var topW = _dist(corners.topLeft, corners.topRight);
      var botW = _dist(corners.bottomLeft, corners.bottomRight);
      var leftH = _dist(corners.topLeft, corners.bottomLeft);
      var rightH = _dist(corners.topRight, corners.bottomRight);
      var longer = Math.max(topW, botW, leftH, rightH);
      var shorter = Math.min(
        Math.max(topW, botW),
        Math.max(leftH, rightH)
      ) || 1;

      if (longer / shorter < this.options.minLongShortRatio) return null;

      return corners;
    } catch (_) {
      return null;
    }
  };

  /**
   * Perspective-correct crop.
   *
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} source
   * @param {{ topLeft, topRight, bottomRight, bottomLeft }} corners
   * @returns {HTMLCanvasElement | null}
   */
  MiniScanbot.prototype.crop = function (source, corners) {
    try {
      return this._engine.extractReceipt(source, corners) || null;
    } catch (_) {
      return null;
    }
  };

  /**
   * Same as crop() but returns a JPEG data-URL.
   *
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} source
   * @param {{ topLeft, topRight, bottomRight, bottomLeft }} corners
   * @returns {string | null}
   */
  MiniScanbot.prototype.cropAsDataUrl = function (source, corners) {
    var canvas = this.crop(source, corners);
    return canvas ? canvas.toDataURL("image/jpeg", this.options.jpegQuality) : null;
  };

  // ── Scanbot-compatible aliases ────────────────────────────────────────────
  MiniScanbot.prototype.findReceiptCorners = MiniScanbot.prototype.detect;
  MiniScanbot.prototype.extractReceipt     = MiniScanbot.prototype.crop;

  // ─── Private helpers ──────────────────────────────────────────────────────
  function _dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function _polygonArea(pts) {
    var area = 0;
    for (var i = 0; i < pts.length; i++) {
      var cur = pts[i];
      var nxt = pts[(i + 1) % pts.length];
      area += cur.x * nxt.y - nxt.x * cur.y;
    }
    return Math.abs(area / 2);
  }

  // ─── Export ───────────────────────────────────────────────────────────────
  global.MiniScanbot = MiniScanbot;

}(typeof globalThis !== "undefined" ? globalThis : window));
