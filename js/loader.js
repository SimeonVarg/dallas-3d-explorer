/**
 * loader.js — the load screen, and the one hard constraint it is built around.
 *
 * WHY THIS IS ALL CSS AND ALMOST NO JAVASCRIPT.
 *
 * The site takes ~20 s to become interactive and almost none of that is the
 * network: measured on the live site, all 44 requests and 2.2 MB finish by
 * 2.5 s. The rest is the main thread, flat out — parsing ~22 MB of GeoJSON
 * (6.3 MB of trees alone), generating the 128-tile facade atlas, and letting
 * MapLibre tile 12,000 trees, 7,625 outer-ring buildings and 12,058 roof
 * features.
 *
 * So the thread this screen would animate on is exactly the thread that is
 * blocked. A requestAnimationFrame loop here would sit frozen for seconds at a
 * time, which reads as a crashed page — strictly worse than no load screen at
 * all. Everything that MOVES is therefore a CSS animation on transform or
 * opacity, which the compositor runs on its own thread and which keeps going
 * smoothly while JS is stuck. JavaScript only ever sets a value at a stage
 * boundary, when the thread is briefly free anyway.
 *
 * The skyline is the favicon's three bars grown up: the mark is already a
 * little skyline, so the load screen is that motif at full size, lighting up
 * window by window as the real city assembles behind it.
 *
 * WHAT IS MEASURED AND WHAT IS PACED — the honest split.
 *
 *   The RAIL and the STATUS TEXT are real. Both are driven by app.js calling
 *   window.loaderStage(name) at each buildScene() boundary. No timers.
 *
 *   The SKYLINE is paced, and has to be. Instrumenting a real load shows all 26
 *   stages firing between 1678 ms and 1954 ms — the whole named build is 276 ms
 *   — while the veil does not lift until 9007 ms. Lighting a building per stage
 *   therefore flashes the entire city on at once and then leaves seven seconds
 *   of nothing. The buildings instead light on a CSS stagger spread across the
 *   real wait, which is also the only thing that can animate while the main
 *   thread is blocked.
 */
(function () {
  'use strict';

  // ── Taste block ─────────────────────────────────────────────────────
  // Every word on this screen is here, so any of it can be changed in one line.
  const L = {
    BARS: 15,                 // one per weighted stage, plus the boot bar
    LIT_ROWS: 7,              // window rows in the tallest bar
    GLOW: 'rgba(245,166,35,.30)',
    TITLE: 'Dallas 3D Explorer',
    SUBTITLE: 'Downtown Dallas, modelled and flyable',
    // Asked for by name: "Put my credentials Simeon Varghese on the loading
    // screen." Exactly that name, as its own line, at the foot of the frame.
    CREDIT_ROLE: 'Built by',
    CREDIT: 'Simeon Varghese',
  };

  // ── The skyline's landmarks ─────────────────────────────────────────
  //
  // Reported: "replace the generic building silhouettes with iconic ones: the
  // Capitol, the UT Tower, etc." Three of the fifteen bars are now shaped, and
  // they are the three the stage order already puts in the right places: the
  // buildings stage becomes the UT Tower, the capitol stage becomes the Capitol,
  // and the outer-ring stage — the rest of Austin — becomes downtown's crown.
  //
  // THESE SHAPES ARE AUTHORED, NOT SOURCED. The repo does carry real footprints
  // and real heights for all three, but a footprint is a plan and this is an
  // elevation: nothing in data/ describes the Tower's setbacks or the Capitol's
  // dome in the vertical, and bake_tower.py builds its massing from stacked
  // rings rather than a profile. So these are drawn by hand to read at 40 px
  // wide, and they are labelled as drawn rather than dressed up as data.
  //
  // The height each shape needs to be legible is its own, and overrides the
  // stage's skyline height — a dome on a 52%-tall bar is a bump.
  // DALLAS. Same rule as Austin's: pick the landmarks a stranger can name from
  // a silhouette alone, and put each on the stage that is genuinely building
  // it. Reunion Tower is the obvious one — a ball on a stick is unmistakable at
  // 40 px and nothing else in America looks like it. Bank of America Plaza is
  // the tallest thing here and anchors the right of the row. Renaissance Tower
  // earns its place on the twin masts, not on its box.
  const SHAPES = {
    heroes:    { shape: 'reunion',     h: 0.72 },
    buildings: { shape: 'boa-plaza',   h: 1.00 },
    outer:     { shape: 'renaissance', h: 0.94 },
  };

  // The stages, in the order app.js runs them, with the share of the wait each
  // one owns. The weights are not guesses: they are the measured split, and the
  // three that dominate are the three with the most features — trees and props
  // (detail), the outer ring, and the roofscape. `boot` covers everything before
  // buildScene(): the fetch, the JSON parse and the style load.
  //
  // Heights are a skyline, not data — but the ORDER is the real build order, so
  // the bar that is rising is genuinely the thing being built.
  //
  // DALLAS WEIGHTS. Austin's `capitol` and `stadium` stages are gone — this repo
  // has neither module — and two are new: `heroes`, which builds the five
  // hand-massed towers, and `highways`, which builds the elevated deck network.
  // The weights are re-normalised by TOTAL below, so they do not have to sum to
  // anything in particular; what matters is their RATIO to each other.
  const STAGES = [
    ['boot',      22, 0.42],
    ['facades',    7, 0.70],
    ['buildings', 12, 1.00],
    ['ground',     5, 0.55],
    ['props',      7, 0.62],
    ['shadows',    4, 0.48],
    ['roofs',      6, 0.78],
    ['heroes',     6, 0.72],
    ['highways',   8, 0.30],
    ['detail',    12, 0.88],
    ['labels',     2, 0.34],
    ['outer',      8, 0.94],
    ['sky',        2, 0.40],
    ['graphics',   2, 0.30],
    ['controls',   2, 0.26],
  ];
  // What each stage is actually doing, in words a person would use. Counts are
  // the real feature counts in data/, not decoration.
  const SAYS = {
    boot:      'Reading the city',
    facades:   'Drawing 128 facade textures',
    buildings: 'Raising 2,220 buildings',
    ground:    'Paving the street grid',
    props:     'Placing street props',
    shadows:   'Casting shadows',
    roofs:     'Fitting roof details',
    heroes:    'Massing the five towers by hand',
    highways:  'Stacking the Mixmaster',
    detail:    'Planting trees',
    labels:    'Naming the landmarks',
    outer:     'Sketching the city beyond',
    sky:       'Hanging the sky',
    graphics:  'Tuning the lens',
    controls:  'Handing you the controls',
  };

  const TOTAL = STAGES.reduce((s, x) => s + x[1], 0);
  let done = 0, idx = 0, el = null, fill = null, status = null, pct = null, bars = [];

  function build() {
    const veil = document.getElementById('veil');
    if (!veil) return false;
    const mark = document.getElementById('veil-mark');
    if (mark) mark.remove();          // replaced by the full skyline below

    el = document.createElement('div');
    el.id = 'veil-load';
    // The stack, top to bottom: glow, skyline, ground line, then the title
    // block, then the credit pinned to the foot of the frame. The whole
    // assembly is CENTRED now rather than parked at the bottom — the old
    // layout left the top 55% of a 1600x1000 frame as empty brown, which is
    // the single biggest reason the screen read as unfinished.
    el.innerHTML =
      '<div id="vl-glow"></div>' +
      '<div id="vl-frame"></div>' +
      '<div id="vl-stack">' +
        '<div id="vl-city"></div>' +
        '<div id="vl-ground"></div>' +
        '<div id="vl-foot">' +
          '<div id="vl-titlerow"><i class="vl-rule"></i>' +
            '<div id="vl-title"></div><i class="vl-rule"></i></div>' +
          '<div id="vl-sub"></div>' +
          '<div id="vl-rail"><i id="vl-fill"></i></div>' +
          '<div id="vl-row"><span id="vl-status">Reading the city</span><span id="vl-pct">0%</span></div>' +
        '</div>' +
      '</div>' +
      '<div id="vl-credit"><span id="vl-credit-role"></span><span id="vl-credit-name"></span></div>';
    veil.appendChild(el);
    // textContent, not innerHTML, for every authored string: these are taste
    // values a future edit will change without thinking about escaping.
    el.querySelector('#vl-title').textContent = L.TITLE;
    el.querySelector('#vl-sub').textContent = L.SUBTITLE;
    el.querySelector('#vl-credit-role').textContent = L.CREDIT_ROLE;
    el.querySelector('#vl-credit-name').textContent = L.CREDIT;

    const city = el.querySelector('#vl-city');
    for (let i = 0; i < STAGES.length; i++) {
      const b = document.createElement('div');
      b.className = 'vl-bar';
      const land = SHAPES[STAGES[i][0]];
      if (land) b.dataset.shape = land.shape;
      b.style.setProperty('--h', ((land ? land.h : STAGES[i][2]) * 100).toFixed(1) + '%');
      // Two staggers. --i paces when this building lights up, spread across the
      // real wait; --d offsets its window shimmer so the skyline never pulses in
      // unison. Both are consumed by CSS animations, never by JS.
      b.style.setProperty('--i', i);
      b.style.setProperty('--d', (i * 0.13).toFixed(2) + 's');
      // A grid of lit windows across a dome or a spire reads as a mistake, so
      // the shaped bars carry fewer and the CSS insets them further.
      const rows = land ? Math.max(2, Math.round(L.LIT_ROWS * 0.5))
                        : Math.max(2, Math.round(STAGES[i][2] * L.LIT_ROWS));
      let win = '';
      for (let r = 0; r < rows; r++) win += '<i></i><i></i>';
      b.innerHTML = '<u></u><s>' + win + '</s>';
      city.appendChild(b);
      bars.push(b);
    }
    fill = el.querySelector('#vl-fill');
    status = el.querySelector('#vl-status');
    pct = el.querySelector('#vl-pct');
    startBootFloor();
    return true;
  }

  // MEASURED, and it is not what the first cut of this file assumed.
  //
  // Instrumenting every stage boundary on a real load gives: the page spends
  // ~1.7 s fetching and parsing before buildScene() runs at all, then ALL 26
  // stages fire between 1678 ms and 1954 ms — the entire named build is 276
  // MILLISECONDS — and the veil does not lift until 9007 ms. So roughly 78% of
  // the wait is one block with no stages in it at all: MapLibre tiling and
  // rasterising everything buildScene just handed it, until the first idle frame.
  //
  // The first cut gave those 276 ms 88% of the bar and the seven-second block
  // 12%. That is a progress bar that sprints to 88% and then sits, which is the
  // single worst-looking state a progress bar has. The split below is the
  // measured one: stages take it to ~34%, and the long tail owns the rest.
  //
  // That tail is a CSS creep — one transform with a long transition, run by the
  // COMPOSITOR, so it keeps gliding through exactly the multi-second main-thread
  // blocks that would freeze anything driven from JS. It never reaches 100%:
  // only loaderDone(), on the real first frame, does that.
  const STAGE_SHARE = 0.30;
  // CREEP_MS tracks INTRO.minVeilMs in app.js — the FLOOR the veil never lifts
  // before. The gate above that floor is covered by loaderWaiting()'s second
  // glide, not by stretching this one: stretching it would make the rail lag on
  // a fast machine, where the floor is all there is for the first seconds.
  const CREEP_TO = 0.97, CREEP_MS = 7600;   // ~= INTRO.minVeilMs in app.js

  // ── The tail, which used to be a lie ────────────────────────────────
  //
  // Reported: "The progress bar jumps from 7% to almost-done." Both numbers are
  // exactly what the code above produces. `boot` is weighted 22 of 100 and every
  // stage is capped at STAGE_SHARE, so the bar sits at 22 * 0.30 = 6.6% for the
  // ~1.7 s of fetch and parse — that is the 7%. Then all fourteen remaining
  // stages fire inside 276 ms, which takes it to 30% in a quarter of a second,
  // and the last 70% was a timed CSS creep with no connection to anything.
  //
  // The tail is not idle time: it is MapLibre tiling and rasterising ~22 MB of
  // GeoJSON across 22 sources. That HAS a real signal — each source reports
  // isSourceLoaded() when its worker is done — and counting them is what the
  // rail rides now.
  //
  // The floor stays, because it has a job the signal cannot do. While the main
  // thread is buried, no event fires and no JS runs, so a purely event-driven
  // rail freezes for seconds at a time and reads as a crashed page. The floor is
  // a compositor-side transform that keeps gliding through those blocks. It is
  // strictly a FLOOR: the moment a real reading is higher, the real reading
  // wins, and the floor is capped below 100 so only loaderDone() can finish.
  //
  // These are the app's own sources. A source that never appears (a pass module
  // disabled, a snapshot without the stadium) must not stall the bar, so the
  // denominator counts sources that have been ADDED, and `expected` is only a
  // floor under that count — an unknown source is progress, not a hang.
  const SOURCES_EXPECTED = 22;
  let srcSeen = new Set(), srcDone = new Set(), tailFrac = 0, finished = false;
  // Where the compositor floor is currently gliding to. The real readings and
  // the floor are two writers on one style property and the LAST WRITE WINS, so
  // they have to cooperate rather than race: measured, every stage boundary was
  // overwriting the long floor transition with its own 420 ms one, which pinned
  // the rail at 30% for the whole tail and read exactly like the bug being
  // fixed. A real reading now only takes the wheel when it is actually ahead of
  // where the floor is going.
  let floorTarget = 0;

  function tailProgress() {
    if (!srcSeen.size) return 0;
    const denom = Math.max(SOURCES_EXPECTED, srcSeen.size);
    return Math.min(1, srcDone.size / denom);
  }

  /**
   * Where the rail is on screen RIGHT NOW, read off the compositor.
   *
   * This matters because the floor below is a CSS transition: the element's
   * transform is its TARGET, not its current position, and comparing a real
   * reading against the target would let a slow real reading pull the bar
   * BACKWARDS mid-glide.
   */
  function shown() {
    if (!fill) return 0;
    try { return new DOMMatrixReadOnly(getComputedStyle(fill).transform).a; } catch (e) { return 0; }
  }

  // Debug/test hook, the same shape as window.__ae and window.__fly. The rail is
  // a compositor transition, so SAMPLING it from the page cannot distinguish a
  // smooth glide from a jump — the sampler shares the blocked main thread and
  // gets ~13 readings across an 18 s load. What can be judged is every write:
  // its target, how long it was given, and who made it.
  window.__railWrites = [];
  function note(kind, f, ms) {
    try { window.__railWrites.push({ kind: kind, to: +f.toFixed(4), ms: ms, t: Math.round(performance.now()) }); } catch (e) {}
  }

  /** Move the rail to `f`, but never backwards. */
  function railTo(f, ms, ease) {
    if (!fill || finished) return;
    if (f <= shown() + 0.0005) return;
    note('real', f, ms);
    fill.style.transitionDuration = ms + 'ms';
    fill.style.transitionTimingFunction = ease || 'cubic-bezier(.16,1,.3,1)';
    fill.style.transform = 'scaleX(' + f.toFixed(4) + ')';
    if (pct) pct.textContent = Math.round(f * 100) + '%';
  }

  /**
   * THE FLOOR — and why it is a CSS transition and not a timer.
   *
   * The first attempt at fixing the jump drove the tail from setTimeout. It
   * made things worse in the most instructive way: the trace showed the rail at
   * 7%, 7%, then 39%, because the main thread is blocked for the entire tail and
   * a timer on a blocked thread does not tick. That is precisely what this
   * file's header has said since it was written. A single long CSS transition is
   * handed to the COMPOSITOR, which has its own thread and keeps gliding through
   * multi-second blocks — it is the only thing here that can.
   *
   * So the floor is a guarantee of motion, and the real readings below override
   * it whenever the thread is free enough to produce one.
   */
  function floorTo(f, ms) {
    if (!fill || finished) return;
    floorTarget = Math.max(floorTarget, f);
    note('floor', f, ms);
    fill.style.transitionDuration = ms + 'ms';
    fill.style.transitionTimingFunction = 'cubic-bezier(.12,.7,.25,1)';
    fill.style.transform = 'scaleX(' + f.toFixed(4) + ')';
  }

  function paint() {
    if (finished) return;
    const stageF = Math.min(1, done / TOTAL) * STAGE_SHARE;
    const real = stageF + tailFrac * (CREEP_TO - STAGE_SHARE);
    // Only overtake the floor, never interrupt it. See floorTarget above.
    if (real > floorTarget) railTo(real, 420);
    else if (pct) pct.textContent = Math.round(Math.max(real, shown()) * 100) + '%';
  }

  /**
   * Subscribe to the real thing. `sourcedata` fires per source per tile batch,
   * and isSourceLoaded is the honest per-source "done" — it is what the shot
   * scripts already wait on.
   *
   * HONEST LIMIT, measured: during the tail the main thread is saturated, so
   * these handlers do not get to run and the readings arrive in a lump near the
   * end rather than smoothly. The signal is real when it lands; the floor is
   * what carries the bar in between. There is no third option on one thread.
   */
  window.loaderWatch = function loaderWatch(map) {
    if (!map || !map.on) return;

    /**
     * THE FULL SWEEP — `map.getStyle()`, which is not cheap and must not be on
     * the hot path.
     *
     * MEASURED, V8 sampler, cold boot, 2026-08-16 (HANDOFF §133): this ran on
     * EVERY `sourcedata` event, and `sourcedata` fires per source per tile
     * batch — hundreds of times across a boot. Each call serialised the whole
     * style (213 layers and 26 sources, deep-cloned into a plain object) and
     * then called shown(), which does `getComputedStyle(fill).transform` and so
     * forces a synchronous style recalc. `shown` alone was 172 ms of SELF time
     * in the first 8 s and 135 ms inside the single 2.3 s blocking task — i.e.
     * the load screen was spending real milliseconds of the load it is drawing.
     *
     * So the sweep is now the RARE path: once at subscribe, and on `idle`. It
     * still exists because a source can be added and finish before we
     * subscribe, and the event below would never mention it.
     */
    const sweep = () => {
      if (finished) return;
      let changed = false;
      const srcs = (map.getStyle && map.getStyle().sources) || {};
      for (const id of Object.keys(srcs)) {
        if (!id.startsWith('austin')) continue;      // the basemap is not our wait
        if (!srcSeen.has(id)) { srcSeen.add(id); changed = true; }
        if (!srcDone.has(id) && isLoaded(map, id)) { srcDone.add(id); changed = true; }
      }
      if (changed) settleReading();
    };

    const isLoaded = (m, id) => { try { return m.isSourceLoaded(id); } catch (e) { return false; } };
    const settleReading = () => { tailFrac = tailProgress(); paint(); updateTailStatus(); };

    /**
     * THE HOT PATH — the event already carries everything the sweep went
     * looking for. `e.sourceId` names the source and `e.isSourceLoaded` is the
     * same boolean `isSourceLoaded(id)` returns, so reading them off the event
     * is not an approximation of the sweep, it IS the sweep's answer, arriving
     * for free. No getStyle, no per-source query, and paint() only when a set
     * actually grew — which is at most 26 times in a boot instead of hundreds.
     */
    map.on('sourcedata', (e) => {
      if (finished || !e || !e.sourceId || !e.sourceId.startsWith('austin')) return;
      let changed = false;
      if (!srcSeen.has(e.sourceId)) { srcSeen.add(e.sourceId); changed = true; }
      if (e.isSourceLoaded && !srcDone.has(e.sourceId)) { srcDone.add(e.sourceId); changed = true; }
      if (changed) settleReading();
    });
    map.on('idle', sweep);
    sweep();
    // buildScene() has handed everything over by the time app.js calls this, so
    // this — not "all fifteen stage names have fired" — is when the named build
    // is genuinely done. Gating the tail floor on the stage COUNT was wrong: a
    // pass module that is disabled, or a stage renamed, leaves idx short forever
    // and the floor never starts. Measured: the rail stopped at 30% and stayed.
    settle();
  };

  // What the tail is actually doing, in words. Without this the status line read
  // "Drawing the first frame" for seven seconds, which is the same
  // non-information the old bar carried.
  function updateTailStatus() {
    if (!status || idx < STAGES.length) return;
    if (holdText) { status.textContent = holdText; return; }   // the gate owns it
    const n = srcDone.size, d = Math.max(SOURCES_EXPECTED, srcSeen.size);
    status.textContent = n >= d ? 'Drawing the first frame'
                                : 'Tiling the city — ' + n + ' of ' + d + ' layers ready';
  }

  /**
   * THE EXTRA WAIT, AND WHY THE BAR HAS TO KNOW ABOUT IT.
   *
   * app.js's INTRO gate holds the veil past its floor when the sources the
   * opening frame needs are not drawable yet (the "flies over empty land"
   * report). That wait is real and it is the honest thing to do, but a load
   * screen that has already run its rail to the end and then sits there reads
   * as a hang — which is the same defect the tail creep was written to fix, one
   * stage further along.
   *
   * So the gate calls in, and two things happen: the status line stops
   * reporting layer COUNTS and starts reporting the thing actually being waited
   * for, and the floor gets a second glide sized to the gate's own remaining
   * budget so the compositor keeps the rail moving through it. `srcDone` is the
   * rail's signal and it is deliberately monotonic; the gate's signal is
   * viewport-scoped and can go backwards, so it drives WORDS, never the rail.
   *
   * n, d — sources ready / sources needed for the opening frame.
   * budgetMs — how long the gate may still hold, i.e. its ceiling minus floor.
   */
  let holdText = null, holdFloored = false;
  window.loaderWaiting = function loaderWaiting(n, d, budgetMs) {
    if (finished) return;
    holdText = (n >= d) ? 'Drawing the first frame'
                        : 'Loading downtown — ' + n + ' of ' + d + ' layers ready';
    if (status) status.textContent = holdText;
    if (!holdFloored) {
      holdFloored = true;
      floorTo(CREEP_TO, Math.max(1000, budgetMs || 8000));
    }
  };

  // The bar used to sit at 7% for the ~1.7 s of fetch and parse before
  // buildScene() runs, because `boot` is the only stage that has fired by then.
  // Nothing is measurable in that window — it is one long parse — so the floor
  // starts immediately and covers it. Motion from the first paint.
  function startBootFloor() {
    setTimeout(() => floorTo(STAGE_SHARE * 0.9, 2400), 60);
  }

  function settle() {
    if (!fill) return;
    updateTailStatus();
    // Stop short of CREEP_TO so a real reading still has somewhere to go, and
    // so only loaderDone() can finish the bar.
    floorTo(STAGE_SHARE + (CREEP_TO - STAGE_SHARE) * 0.88, CREEP_MS);
  }

  /** Called by app.js at each stage boundary. Unknown names are ignored. */
  window.loaderStage = function loaderStage(name) {
    const i = STAGES.findIndex(s => s[0] === name);
    if (i < 0 || i < idx) return;
    // The SKYLINE is paced by CSS, not by these stages, and that is deliberate:
    // the stages all fire inside 276 ms, so lighting a bar on each one makes the
    // whole city flash on at once and then nothing moves for seven seconds. The
    // bars instead light on a CSS stagger spread across the real wait, which is
    // the only thing that can keep animating while the main thread is blocked.
    //
    // The honest signals are the RAIL and the STATUS TEXT: both are driven from
    // here, from what actually just happened.
    if (el && i > 0) el.classList.add('building');
    for (let k = idx; k <= i; k++) done += STAGES[k][1];
    idx = i + 1;
    if (status) status.textContent = SAYS[name] || name;
    paint();
    if (idx >= STAGES.length) settle();
  };

  /** Called when the scene is genuinely ready; hands off to the veil lift. */
  window.loaderDone = function loaderDone() {
    idx = STAGES.length;
    done = TOTAL;
    if (status) status.textContent = 'Welcome to Austin';
    floorTarget = 1;
    note('done', 1, 420);
    if (fill) {
      fill.style.transitionDuration = '420ms';
      fill.style.transitionTimingFunction = 'cubic-bezier(.16,1,.3,1)';
      fill.style.transform = 'scaleX(1)';
    }
    finished = true;
    if (pct) pct.textContent = '100%';
    if (el) el.classList.add('vl-done');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { if (build()) window.loaderStage('boot'); });
  } else if (build()) {
    window.loaderStage('boot');
  }
})();
