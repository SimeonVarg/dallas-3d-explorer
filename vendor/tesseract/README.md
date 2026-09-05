# vendor/tesseract — the on-device reader

Five files, 5.1 MB, all served from this origin. `js/schedimg.js` fetches them
**only when a student actually picks an image**; nothing here is on the app's
cold-load path and `scripts/verify/schedimg.mjs` §1 asserts that at the network
level on the real page.

| file | bytes | what it is |
|---|---|---|
| `tesseract.min.js` | 62,961 | Tesseract.js 7.0.0, the browser entry point |
| `worker.min.js` | 111,307 | its Worker script |
| `tesseract-core-simd-lstm.js` | 89,271 | Emscripten glue for the core |
| `tesseract-core-simd-lstm.wasm` | 2,857,601 | the LSTM engine, WebAssembly SIMD build |
| `eng.traineddata.gz` | 1,984,273 | English model, `4.0.0_fast` |

## Why these exact files

**One named core, not a directory to choose from.** Left to pick for itself,
Tesseract.js reaches for the single-file builds (`*-relaxedsimd-lstm.wasm.js`,
3.9 MB each) and would need *two* of them vendored to cover browsers with and
without relaxed SIMD. `TUNE.coreFile` names the split SIMD build instead: 89 KB
of glue plus a 2.86 MB `.wasm` it fetches beside itself. Plain WebAssembly SIMD
has been in every major browser since 2021, and `hasSimd()` in `js/schedimg.js`
feature-tests for it rather than assuming — a browser without it gets a sentence
saying the reader cannot run here, not a cascade of 404s.

**The `fast` model, not the standard one.** `4.0.0/eng.traineddata.gz` is
10.9 MB; `4.0.0_fast` is 1.98 MB. Five and a half times the bytes, for a corpus
the fast model already reads at 98.4% precision (`docs/img-extract.md`).

**Vendored rather than fetched from a CDN.** Not because a CDN would see the
picture — it would not, the image never leaves the canvas — but because it would
see *that a schedule is being imported*, from an IP, at a time. Same-origin
costs nothing here and removes the question.

## Where they came from

```bash
cd scripts/verify && npm install tesseract.js@7      # 7.0.0
cp node_modules/tesseract.js/dist/tesseract.min.js            ../../vendor/tesseract/
cp node_modules/tesseract.js/dist/worker.min.js               ../../vendor/tesseract/
cp node_modules/tesseract.js-core/tesseract-core-simd-lstm.js   ../../vendor/tesseract/
cp node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm ../../vendor/tesseract/
curl -o ../../vendor/tesseract/eng.traineddata.gz \
  https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz
```

Licences: Tesseract.js is Apache-2.0 (`tesseract.min.js.LICENSE.txt` in the npm
package); the Tesseract engine and the `eng` model are Apache-2.0.

## Disk

5.1 MB tracked, and a tracked file is copied into every parallel worktree — see
CLAUDE.md "Disk". That is the cost of the feature shipping at all; it is paid
once and it does not grow.
