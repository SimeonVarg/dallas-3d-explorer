/**
 * walkgraph.js — how many minutes it is between two building codes, and nothing
 * else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * `js/schedconfirm.js` has one cross-check nothing else on a student's phone
 * can do: a class twelve minutes after another one, in a building nineteen
 * minutes away on foot, is not a tight passing period — it is a contradiction,
 * and one of the two readings is wrong. That check was built, tested against an
 * injected route function, and INERT in the real app, because the only router
 * in this repo is `window.wayfindRoute` and that function is async, drives the
 * UI, fills both router inputs and draws a ribbon across the city. You cannot
 * use it as a quiet probe behind a confirm screen. Asking a student "which
 * building is this?" must not repaint the map underneath them.
 *
 * So this is the probe. It reads the same `data/walk_graph.json` the router
 * reads, uses the cost model the BAKE shipped inside that file rather than any
 * number typed here, and answers one question with no side effects at all:
 *
 *     minutes('MEZ', 'WEL')  ->  { lo: 2, hi: 4, metres: 221 }
 *
 * No DOM. No globals. No fetch except the app's own same-origin data file, and
 * that one only when somebody actually asks a question. It is a second reader
 * of one file, not a second copy of the walking feature: there is no UI here,
 * no door prose, no step-free mode, no via stop, no ribbon.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT IS A FLOOR, ON PURPOSE, AND THAT IS THE WHOLE SAFETY ARGUMENT
 *
 * `lo` is the fast end of the app's own printed range: 1.4 m/s, no wait at any
 * light. `schedconfirm` compares a gap against `lo` and never against `hi`,
 * which means the sentence it is allowed to say is the strong one — *even at a
 * brisk walk with every light green, this does not fit*. Comparing against the
 * slow end would let the app tell a student their own schedule is impossible
 * because they might dawdle, and that is a question that costs a tap and
 * teaches them to stop reading the questions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DELIBERATELY DOES NOT COPY FROM `js/wayfind.js`
 *
 * The router runs TWO passes and lets a side door win when it saves a walk,
 * handicapping doors by `role` (a loading bay has to beat a big number). That
 * exists so the drawn route enters a building by a door a person would use.
 * Nothing here is drawn, so the handicap is dropped and EVERY door of a
 * building is a legal end — which can only ever make the answer smaller, i.e.
 * more of a floor. Step-free mode, the via stop, the incline model and the
 * `wc` table are all absent for the same reason: they change which route is
 * drawn, and this file draws nothing.
 *
 * What IS copied exactly, because a different answer here than in the router
 * would be a defect: the delta decode, the CSR adjacency, the `OFF_MAIN` rule
 * (never route onto a stranded island), the crossing penalty, the per-STAIRCASE
 * fixed cost divided across the edges one staircase was split into, and the
 * 4.0x link-cost multiplier that stops the router taking a 27 m straight line
 * across a lawn. `scripts/verify/schedconfirm.mjs` §2d checks this file against
 * `window.wayfindRoute` on real pairs and prints the difference rather than
 * asserting the two are the same by inspection.
 *
 * EVERY TASTE VALUE IS IN `WALKG` BELOW, ONE EDIT EACH (CLAUDE.md rule 11).
 */

export const WALKG = {
  // Same file the router reads. Resolved against this module's own URL so it
  // does not depend on where the page lives.
  url: '../data/walk_graph.json',
  // What an unsurveyed door link costs per metre. `js/wayfind.js`'s
  // LINK_COST_MULT, and it has to stay in step with it: at 1.0 the router takes
  // a straight line across a flowerbed whenever it saves a metre.
  linkCostMult: 4.0,
  // A door may be up to three anchors; all of them are legal here.
  on: true,
  // Answers are memoised per code pair for the life of the module. A confirm
  // screen asks the same handful of pairs several times over.
  memo: true,
};

/* Edge flag bits, from the file's own `_format` string. */
const F_STEPS = 1, F_CROSS = 2, F_SIGNAL = 4, F_OFFMAIN = 128;

let loadPromise = null;

/**
 * Decode the delta-coded file into typed arrays plus a CSR adjacency.
 * Byte-for-byte the same shape `js/wayfind.js`'s decode() produces, minus the
 * fields only the UI uses.
 */
export function decodeWalkGraph(g) {
  const Q = g.q, N = g.n.x.length, E = g.e.a.length;
  const X = new Float64Array(N), Y = new Float64Array(N);
  let ax = 0, ay = 0;
  for (let i = 0; i < N; i++) { ax += g.n.x[i]; ay += g.n.y[i]; X[i] = ax * Q; Y[i] = ay * Q; }
  const A = new Int32Array(E), B = new Int32Array(E);
  let a = 0;
  for (let i = 0; i < E; i++) { a += g.e.a[i]; A[i] = a; B[i] = a + g.e.b[i]; }
  const W = Int32Array.from(g.e.w), F = Uint8Array.from(g.e.f), S = Int32Array.from(g.e.s);

  const deg = new Int32Array(N);
  for (let i = 0; i < E; i++) { deg[A[i]]++; deg[B[i]]++; }
  const off = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) off[i + 1] = off[i] + deg[i];
  const to = new Int32Array(2 * E), eix = new Int32Array(2 * E);
  const cur = Int32Array.from(off.subarray(0, N));
  for (let i = 0; i < E; i++) {
    to[cur[A[i]]] = B[i]; eix[cur[A[i]]++] = i;
    to[cur[B[i]]] = A[i]; eix[cur[B[i]]++] = i;
  }
  // How many edges each `highway=steps` way was split into, so a long flight
  // costs its fixed "spot it and turn onto it" second ONCE and not fourteen
  // times. Copied from the router for exactly that reason.
  const swEdges = new Map();
  for (let i = 0; i < E; i++) if (S[i] >= 0) swEdges.set(S[i], (swEdges.get(S[i]) || 0) + 1);

  return {
    N, E, X, Y, A, B, W, F, S, off, to, eix, swEdges,
    doors: g.d, code: g.code, q: Q, meta: g.meta || {},
    // THE COST MODEL COMES OUT OF THE FILE, NOT OUT OF THIS SOURCE. The bake
    // owns the arithmetic; anything typed here could drift away from the graph
    // it is being applied to.
    tune: g.tune || {},
    asOf: g.as_of || null,
    memo: new Map(),
  };
}

/** Edge cost in equivalent flat metres — `js/wayfind.js`'s edgeCost(), symmetric. */
function edgeCost(G, i) {
  const T = G.tune;
  const m = G.W[i] / 100;
  if (G.F[i] & F_STEPS) {
    const n = G.swEdges.get(G.S[i]) || 1;
    return m * (T.WALK_SPEED_LOW_MS / T.STAIR_SPEED_MPS) +
      (T.STAIR_FIXED_S * T.WALK_SPEED_LOW_MS) / n;
  }
  let c = m;
  if (G.F[i] & F_CROSS) c += T.CROSSING_PENALTY_M;
  return c;
}

/** Every graph node a building's doors reach, with the true metres to each. */
function anchorsOf(G, code) {
  const ds = G.code && G.code[code];
  if (!ds || !ds.length) return null;
  const out = [];
  for (const di of ds) {
    const d = G.doors[di];
    if (!d) continue;
    for (let k = 0; k < d[2].length; k++) out.push({ node: d[2][k], c: d[3][k] / 100 });
  }
  return out.length ? out : null;
}

/**
 * The cheapest walk between two codes, measured off the path it actually found
 * rather than estimated from its cost. Returns null when either code has no
 * door in this graph — SILENCE, never a guess, is the answer when the data is
 * not there.
 */
export function routeBetween(G, fromCode, toCode) {
  if (!G || !WALKG.on) return null;
  const a = String(fromCode || '').toUpperCase(), b = String(toCode || '').toUpperCase();
  if (!a || !b) return null;
  if (a === b) return { lo: 0, hi: 0, metres: 0, flat: 0, stair: 0, signals: 0 };
  const key = a + '>' + b;
  if (WALKG.memo && G.memo.has(key)) return G.memo.get(key);

  const seeds = anchorsOf(G, a), targets = anchorsOf(G, b);
  let res = null;
  if (seeds && targets) {
    const mult = WALKG.linkCostMult;
    const N = G.N;
    const dist = new Float64Array(N).fill(Infinity);
    const prevE = new Int32Array(N).fill(-1);
    const prevN = new Int32Array(N).fill(-1);
    const tmap = new Map();
    for (const t of targets) {
      const p = tmap.get(t.node);
      if (!p || t.c < p.c) tmap.set(t.node, t);
    }
    const hn = [], hd = [];
    const push = (n, d) => {
      hn.push(n); hd.push(d);
      let i = hn.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hd[p] <= hd[i]) break;
        const td = hd[p]; hd[p] = hd[i]; hd[i] = td;
        const tn = hn[p]; hn[p] = hn[i]; hn[i] = tn;
        i = p;
      }
    };
    const pop = () => {
      const n = hn[0], d = hd[0];
      const ln = hn.pop(), ld = hd.pop();
      if (hn.length) {
        hn[0] = ln; hd[0] = ld;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let s = i;
          if (l < hd.length && hd[l] < hd[s]) s = l;
          if (r < hd.length && hd[r] < hd[s]) s = r;
          if (s === i) break;
          const td = hd[s]; hd[s] = hd[i]; hd[i] = td;
          const tn = hn[s]; hn[s] = hn[i]; hn[i] = tn;
          i = s;
        }
      }
      return [n, d];
    };
    for (const s of seeds) {
      const sc = s.c * mult;
      if (sc < dist[s.node]) { dist[s.node] = sc; push(s.node, sc); }
    }
    let best = null, left = tmap.size;
    while (hn.length) {
      const popped = pop(); const u = popped[0], d = popped[1];
      if (d > dist[u]) continue;
      // Every remaining target still owes its own non-negative door link, so
      // once the cheapest thing in the heap costs more than the answer already
      // in hand there is nothing better left to find. Without this the search
      // walks all 11k nodes on every question.
      if (best && d > best.cost) break;
      if (tmap.has(u)) {
        const t = tmap.get(u);
        const tot = d + t.c * mult;
        if (!best || tot < best.cost) best = { cost: tot, node: u };
        tmap.delete(u); left--;
        if (!left) break;
      }
      for (let k = G.off[u]; k < G.off[u + 1]; k++) {
        const e = G.eix[k];
        if (G.F[e] & F_OFFMAIN) continue;   // never route onto a stranded island
        const v = G.to[k];
        const nd = d + edgeCost(G, e);
        if (nd < dist[v]) { dist[v] = nd; prevE[v] = e; prevN[v] = u; push(v, nd); }
      }
    }
    if (best) {
      // MEASURED OFF THE PATH, never derived from the cost — the cost carries a
      // crossing penalty and a 4x link multiplier in it, and neither of those
      // is a metre anybody walks.
      let flat = 0, stair = 0, signals = 0;
      const sets = new Set();
      let u = best.node;
      while (prevE[u] >= 0) {
        const e = prevE[u], m = G.W[e] / 100;
        if (G.F[e] & F_STEPS) { stair += m; sets.add(G.S[e]); } else flat += m;
        if (G.F[e] & F_SIGNAL) signals++;
        u = prevN[u];
      }
      const T = G.tune;
      const lowS = flat / T.WALK_SPEED_HIGH_MS + stair / T.STAIR_SPEED_MPS +
        sets.size * T.STAIR_FIXED_S + signals * T.SIGNAL_WAIT_LOW_S;
      const highS = flat / T.WALK_SPEED_LOW_MS +
        (stair * T.STAIR_UP_MULT) / T.STAIR_SPEED_MPS +
        sets.size * T.STAIR_FIXED_S + signals * T.SIGNAL_WAIT_HIGH_S;
      let lo = Math.floor(lowS / 60), hi = Math.ceil(highS / 60);
      if (hi <= lo) hi = lo + 1;
      res = { lo, hi, metres: Math.round(flat + stair), flat, stair, signals,
        staircases: sets.size };
    }
  }
  // BOTH DIRECTIONS, and that is sound rather than a shortcut: every term in
  // edgeCost() is symmetric here (the router's incline model, which is not, is
  // deliberately absent — see the header), and a door link costs the same
  // metres whichever end you start from. Symmetric costs give a symmetric
  // optimum. A `null` is cached too, so a code with no door in this graph is
  // asked about once and answered "I do not know" instantly thereafter.
  if (WALKG.memo) { G.memo.set(key, res); G.memo.set(b + '>' + a, res); }
  return res;
}

/**
 * Load the graph once. Same-origin, resolved against this module's own URL,
 * fetched ONLY when somebody calls this — the confirm screen is itself a lazy
 * import, so the app's cold load never sees it.
 *
 * A failure is not an exception. The whole design of the check on the other end
 * is that it goes SILENT when the data is missing rather than guessing, so a
 * 404 here returns null and the cross-check simply does not run.
 */
export async function loadWalkGraph(url) {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const href = url || new URL(WALKG.url, import.meta.url).href;
      const r = await fetch(href);
      if (!r.ok) return null;
      return decodeWalkGraph(await r.json());
    } catch (e) { return null; }
  })();
  return loadPromise;
}

/** Drop the cached graph — for a test that wants a clean load. */
export function releaseWalkGraph() { loadPromise = null; }

/**
 * The whole public shape, in one call:
 *
 *   const w = await walkProbe();
 *   w.minutes('MEZ', 'WEL')   // 2, the FAST end, or null
 *   w.has('NEZ')              // is this code walkable at all in this graph
 *
 * `minutes` is synchronous, pure, memoised and returns null rather than a
 * number it cannot stand behind. That is the entire contract `schedconfirm`
 * needs, and it is the reason this file is 300 lines and not 15,000.
 */
export async function walkProbe(opts = {}) {
  const G = await loadWalkGraph(opts.url);
  if (!G) return null;
  return {
    graph: G,
    asOf: G.asOf,
    codes: Object.keys(G.code || {}),
    has: (c) => !!(G.code && G.code[String(c || '').toUpperCase()]),
    route: (a, b) => routeBetween(G, a, b),
    minutes: (a, b) => {
      const r = routeBetween(G, a, b);
      return r ? r.lo : null;
    },
    metres: (a, b) => {
      const r = routeBetween(G, a, b);
      return r ? r.metres : null;
    },
  };
}

export default walkProbe;
