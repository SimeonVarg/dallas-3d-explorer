/**
 * pattern-lowpass.js — the wrap-safe separable box blur that band-limits a
 * fill-extrusion-pattern tile before MapLibre samples it LINEAR with no
 * mipmaps (docs/pattern-sampling.md §1: `ImageManager.bind()` hardcodes
 * `gl.LINEAR`, no mip level ever generated). This is the "shim-lowpass" fix
 * (docs/shimmer-verdict.md) — a real, blind-confirmed, partial mitigation
 * for the window-crawl defect (docs/shimmer-mechanism.md) — EXTRACTED so
 * more than one atlas can share it (QUEUE, docs/facade-atlas-map.md §2: six
 * files paint `fill-extrusion-pattern` with no band-limit at all).
 *
 * This file is math ONLY, lifted verbatim from js/facades.js's own
 * `softenTile`. It carries no taste (no per-family radius, no per-tier
 * calibration) — each caller keeps its own SOFTEN-shaped config, because
 * facades.js's families and drag.js's families are different vocabularies
 * and a shared taste table would be the wrong shape (see the commit message
 * for why a shared *config* was rejected but a shared *kernel* was not).
 *
 * WHY WRAPPING. The tile repeats, so a clamped blur would darken the four
 * edges and put a visible grid seam every repeat across every wall in the
 * city — the same class of bug as the fascia band that appeared three times
 * up DKR's elevation (js/facades.js's own comment, quoted there verbatim).
 *
 * WHY A SLIDING WINDOW. O(res^2) regardless of radius, not O(res^2 * r): step
 * the window by one and the new sum is the old sum plus the entering sample
 * minus the leaving one. facades.js's own measurement: adding the two-tier
 * chain took `updateFacades` 57.7ms -> 119.7ms, and switching its blur to
 * this shape bought back ~19ms of that. Do not go back to a re-summed loop.
 *
 * `tmp` holds the horizontal window SUM, not the mean, so the vertical
 * running total is a sum of small integers in double and carries no rounding
 * — verified against the old per-pixel implementation over the real atlas:
 * max channel difference 0 on every image (see the facades.js history this
 * was lifted from).
 *
 * Public: window.PatternLowpass = { blurWrap }
 */
(function () {
  'use strict';

  // Reused scratch buffer across every call, from every caller. Safe because
  // this is synchronous, single-threaded canvas work — only one blur is ever
  // in flight — same lifetime facades.js's own module-private `_blurTmp` had,
  // just no longer duplicated per file.
  let _tmp = null;

  /**
   * Wrap-safe separable box blur, blended back over `d` by amount `a`.
   *
   * @param {Uint8ClampedArray} d   RGBA buffer, res*res*4 bytes, mutated in
   *                                place. Alpha is left untouched — a pattern
   *                                tile's alpha is opaque paint, not motion.
   * @param {number} res   width == height of `d`, in texels.
   * @param {number} r     box radius in texels. 0 (or falsy) is a no-op.
   * @param {number} a     0..1 blend amount. <= 0 is a no-op.
   */
  function blurWrap(d, res, r, a) {
    if (!r || a <= 0) return;
    const N = res * res, win = r * 2 + 1, area = win * win;
    if (!_tmp || _tmp.length < N * 3) _tmp = new Float32Array(N * 3);
    const tmp = _tmp;
    const wrap = i => ((i % res) + res) % res;
    // horizontal — tmp keeps the window SUM
    for (let y = 0; y < res; y++) {
      const row = y * res;
      let s0 = 0, s1 = 0, s2 = 0;
      for (let k = -r; k <= r; k++) {
        const i = (row + wrap(k)) * 4;
        s0 += d[i]; s1 += d[i + 1]; s2 += d[i + 2];
      }
      for (let x = 0; x < res; x++) {
        const o = (row + x) * 3;
        tmp[o] = s0; tmp[o + 1] = s1; tmp[o + 2] = s2;
        const ia = (row + wrap(x + r + 1)) * 4, is = (row + wrap(x - r)) * 4;
        s0 += d[ia] - d[is]; s1 += d[ia + 1] - d[is + 1]; s2 += d[ia + 2] - d[is + 2];
      }
    }
    // vertical, and blend straight back into the pixel buffer
    for (let x = 0; x < res; x++) {
      let s0 = 0, s1 = 0, s2 = 0;
      for (let k = -r; k <= r; k++) {
        const o = (wrap(k) * res + x) * 3;
        s0 += tmp[o]; s1 += tmp[o + 1]; s2 += tmp[o + 2];
      }
      for (let y = 0; y < res; y++) {
        const i = (y * res + x) * 4;
        d[i]     += (s0 / area - d[i])     * a;
        d[i + 1] += (s1 / area - d[i + 1]) * a;
        d[i + 2] += (s2 / area - d[i + 2]) * a;
        const oa = (wrap(y + r + 1) * res + x) * 3, os = (wrap(y - r) * res + x) * 3;
        s0 += tmp[oa] - tmp[os]; s1 += tmp[oa + 1] - tmp[os + 1]; s2 += tmp[oa + 2] - tmp[os + 2];
      }
    }
  }

  window.PatternLowpass = { blurWrap };
})();
