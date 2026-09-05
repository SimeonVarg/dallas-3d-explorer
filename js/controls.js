/**
 * controls.js — FLYCAM, the flythrough camera for Austin 3D Explorer
 *
 * Desktop: WASD / arrows to move, drag to look, Q/E or the wheel for altitude,
 *          Shift to boost, R to return to the spawn view.
 * Mobile:  left joystick to move, BOOST to sprint, swipe anywhere to look,
 *          two fingers or double-tap-and-drag for altitude.
 *
 * Exposes initControls(map, scene) and returns a cleanup function.
 *
 * ── The one structural rule ──────────────────────────────────────────────
 * THE CAMERA EYE IS THE STATE. MapLibre's center and zoom are OUTPUTS,
 * derived once per frame and written with a single map.jumpTo(). Nothing else
 * in this file calls setCenter/setZoom/setBearing/setPitch.
 *
 * That is not stylistic. The previous version steered `center` directly in
 * degrees, which made a whole family of defects expressible: longitude deltas
 * that ignored cos(latitude) (east/west ran 13% slow and diagonal headings
 * crabbed off course), an unnormalised input vector (W+D was 41% faster than
 * W), and a `zoomToAlt()` that actually returned Web-Mercator metres-per-pixel
 * — at the spawn zoom it reported 1.7 m when the camera was really 230 m up,
 * so the first tap of Q or E clamped to MIN_ALT and teleported the view from
 * zoom 16.5 to 13.35, with no way back on desktop. Steering the eye in metres
 * and deriving the map pose makes all of those unrepresentable rather than
 * patched.
 *
 * Projection note: MapLibre uses 512-px tiles. The 156543.03392 constant found
 * in most tutorials is the 256-px convention and yields exactly 2x the true
 * altitude. The closed forms below reproduce transform.getCameraAltitude()
 * exactly (verified: 230.4 m at zoom 16.5 / pitch 64 / 800 px canvas).
 *
 * Datum note: every height here assumes transform.elevation === 0, which holds
 * because app.js deliberately leaves terrain disabled. If terrain is ever
 * turned on, `alt` becomes sea-level while final_height stays above-ground; the
 * fix is a queryTerrainElevation term in exactly three places — the floor
 * comparison, the hard net, and the write path.
 */

function initControls(map, scene) {
  'use strict';

  const PI = Math.PI;
  const rad = d => d * PI / 180;
  const deg = r => r * 180 / PI;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const wrap360 = d => ((d % 360) + 360) % 360;

  // ── Projection ────────────────────────────────────────────────────
  const C = 40030228.884;                 // 2 * PI * 6371008.8
  const M_LAT = C / 360;                  // 111195.08 m per degree of latitude
  const mLon = lat => M_LAT * Math.cos(rad(lat));
  const fovDeg = () => (map.getVerticalFieldOfView ? map.getVerticalFieldOfView() : 58);
  const camPx = () => 0.5 * map.getCanvas().clientHeight / Math.tan(rad(fovDeg()) / 2);
  const mpp = (z, lat) => C * Math.cos(rad(lat)) / (512 * Math.pow(2, z));

  // ── Tuning ────────────────────────────────────────────────────────
  const ZOOM_MIN = 14.0;    // trees/shadows drop out below this
  const ZOOM_MAX = 21.5;    // under MapLibre's own maxZoom so our clamp binds first

  // SPEED_MIN was 6 m/s = 21.6 km/h, and because the curve below only reaches 6
  // at 18.2 m it was the ONLY speed the camera had ever had at any altitude the
  // old floor allowed. At walking height that is a car. Dropped to 1.0 so the
  // EXISTING altitude curve does the whole job with no mode and no branch:
  // 1.3 m/s at 1.7 m (walking is 1.4), 1.9 at 4 m, 3.2 at 8 m, 5.9 at 18 m, and
  // not one digit different anywhere above 18.2 m — so the flyover's speed is
  // untouched by arithmetic, not by hope. Shift still gives 2.5x, which is a jog.
  const SPEED_REF = 40, SPEED_EXP = 0.75, SPEED_MIN = 1.0, SPEED_MAX = 120;
  const SPRINT = 2.5;
  const TAU_ACCEL = 0.20, TAU_DECEL = 0.45, V_EPS = 0.05;

  const SENS_YAW_MOUSE = 0.20, SENS_PITCH_MOUSE = 0.13;
  const SENS_YAW_TOUCH = 0.18, SENS_PITCH_TOUCH = 0.11;
  const LOOK_DEADZONE = 0.4;

  // ── The vertical look, when there is barely any of it left ────────
  //
  // MEASURED ON A PHONE AT WALKING HEIGHT, not reasoned about
  // (docs/mobile/driving-at-eye-level.md §1). At 1.7 m the pitch is pinned
  // between pitchFloor() 84.42 and PITCH_MAX 88 — the WHOLE vertical look is
  // 3.58 degrees. At SENS_PITCH_TOUCH 0.11 deg/px that is 33 px of thumb, so a
  // real 150 px swipe landed on the opposite stop every single time across
  // three reps and ten consecutive 10 px nudges were over after the second.
  // The other ~117 px of every swipe moved nothing. That does not read as "a
  // limit"; it reads as the app having hung, which is worse than the limit.
  //
  // So the sensitivity is fitted to the range that actually exists: whatever
  // pitch is available should take about LOOK.PITCH_SPAN_PX of travel to
  // spend. 300 px is roughly a comfortable thumb sweep on an 852 px screen and
  // a short mouse drag.
  //
  // IT CAN ONLY EVER SLOW THE LOOK DOWN, never speed it up — `Math.min` against
  // the authored value. Above 18.47 m the floor is exactly PITCH_MIN and the
  // available range is ~83 deg, which fits in 300 px at 0.277 deg/px, i.e. far
  // coarser than the authored 0.11/0.13, so the authored value wins and NOTHING
  // about the flyover changes. The clamp in the tick is untouched: this changes
  // how much thumb it takes to reach a stop, not where the stop is.
  // Kept on an object rather than as a bare const for one reason: it is the
  // only way the harness can A/B this in a SINGLE browser session. Setting
  // `__fly.look.PITCH_SPAN_PX = 1` makes the fitted value enormous, `Math.min`
  // takes the authored sensitivity, and the stock behaviour is back exactly.
  // Still one line for Simeon to overrule.
  const LOOK = { PITCH_SPAN_PX: 300 };
  // MapLibre 5.24's own hard ceiling is exactly 90 deg, verified against the
  // running library rather than the docs (scripts/verify/pitch-probe.mjs):
  // setMaxPitch(95), (100) and (120) are all ACCEPTED and every one of them
  // still reaches 90.00. Pitch is measured from straight down, so 90 is the
  // camera level with the horizon — this stack cannot tip past it, and "straight
  // up" does not exist here at any setting.
  //
  // We stop at 88 rather than 90 because the eye->pose derivation below divides
  // by cos(pitch) and multiplies by tan(pitch): at 90 the map centre is at
  // infinity and the derived zoom is NaN. At 88 the lead is 28.6 x altitude,
  // which is a real place; at 89.5 it is 114 x, which leaves the modelled world.
  //
  // What 88 buys: the top of the frame sits at (pitch - 90 + fov/2) degrees
  // above horizontal, so 88 with the default 58 fov shows 27 deg of sky, and 41
  // deg at the menu's 82 fov maximum. That is the whole of "looking up" that
  // exists in this renderer.
  const PITCH_MIN = 5, PITCH_MAX = 88;

  // ── THE FLOOR, AND WHY IT IS 1.7 ─────────────────────────────────
  //
  // This was 18 m until 2026-08-05, which is a fourth-floor window, and it was
  // enforced without the user asking: any scripted pose below it was lifted back
  // within ~2 s. Every frame in this repo labelled "street level" was taken from
  // 18 m (HANDOFF §101). Simeon chose walking height over the anti-clipping
  // guarantee that floor bought, having been told what it costs.
  //
  // 1.7 rather than 2.0 because that is what the ground-floor pass was authored
  // for: the entrances bake writes a 2.44 m door head and 0.35 m treads, and the
  // West Campus storefront mullions are 3.95 m. At 2.0 the door head is 0.44 m
  // over your eye and doorways read squat; at 1.7 (US adult eye height is
  // 1.56-1.68) it sits properly overhead. ONE LINE TO OVERRULE.
  //
  // ALT_GROUND is the second dial and it is the more interesting one: it decides
  // where this stops being a flyover. Above it every collision parameter is
  // exactly what it was before this change; below it they blend continuously to
  // their pedestrian values, so there is no step to fall through and no mode to
  // be in the wrong one of. Nothing scripted in this app goes below 113.9 m
  // (SPAWN is 162.9), so the intro, the tour and the default pose never enter
  // the blend at all.
  const ALT_MIN = 1.7, ALT_MAX = 900, ALT_SLACK = 30;
  const ALT_GROUND = 12;
  // Was a bare `Math.max(outAlt, 12)` in writeToMap() with no name and no
  // comment — a SECOND floor, on the written pose rather than on the state, so
  // it would have reported alt 1.7 while posing the map from 12 m. Named here
  // per CLAUDE.md rule 11. It exists to keep the derived zoom finite.
  const ALT_RENDER_MIN = 0.5;
  const VERT_GAIN = 0.25;          // per second, multiplicative
  const WHEEL_GAIN = 0.0018;       // per px
  const PAN2_GAIN = 0.0022;        // per px
  const TAPDRAG_GAIN = 0.0055;     // per px

  // DT_BAIL exists to swallow tab-restore gaps, which are seconds long. It must
  // NOT double as a slow-frame guard: at 0.25 s it discarded every frame under
  // 4 fps outright, so a weak phone (or a headless render) went from choppy to
  // barely moving — measured 8.85 m/s against a 40 m/s target. DT_MAX bounds a
  // single integration step; the collision walk substeps so a long step still
  // cannot tunnel through a facade.
  const DT_MAX = 0.10, DT_BAIL = 1.0;

  const CELL = 6, R_CAM = 6, SKIN = 2.5, SKIN_V = 8, STEP_UP = 12, HARD_CLEAR = 4;
  // ── The same three guards, sized for somebody standing on a pavement ──
  //
  // R_CAM = 6 m is "is there a roof within 6 metres of me horizontally". Above
  // the roofline that reads as "am I about to hit something". On a 3 m pavement
  // it reads as "you are inside the tower you are standing next to", and it is
  // the single measured reason walking did not work: one 0.7 s tap of W on the
  // Nueces pavement threw the camera from 2.0 m to 66.5 m — exactly
  // roofAt(6 m) + HARD_CLEAR. The same probe at R_CAM = 1.0 m moved it 0.8 m.
  //
  // STEP_UP = 12 m is "anything up to 12 m above your eye is a kerb you skim
  // over". At 18 m that hops a parapet. At 1.7 m it makes every building under
  // ~14.5 m — 54% of the campus snapshot — a ramp instead of a wall, so walking
  // at a two-storey house put you on its roof. A pedestrian steps over a kerb.
  //
  // SKIN_V = 8 m is the clearance kept above a surface being ridden. Eight
  // metres above a one-storey roof is a third floor.
  const R_CAM_GROUND = 1.0, SKIN_V_GROUND = 0.8, STEP_UP_GROUND = 0.5;
  const LIFT = 45, FALL = 25, TAU_FLOOR_UP = 0.25, TAU_FLOOR_DOWN = 0.80;
  const FLOOR_LOOKAHEAD = 0.5;
  const BRAKE_PROBES = [[0.9, 0.55], [0.5, 0.30], [0.25, 0.12]];
  const SAFE_ALT = 105;            // fail-safe while the height field is unbuilt

  const FENCE_PAD = 250, FENCE_SOFT = 250;

  // ── How far you may fly ───────────────────────────────────────────
  // ── THE FENCE — how far you may fly ───────────────────────────────
  //
  // Austin's fence was the box its outer-ring bake covered: 77 km2, because
  // that repo models a whole city around the campus and the fence had to reach
  // the edge of it. This repo does not have an outer ring. It has ONE box, the
  // one in scripts/config.sh, and everything that renders is inside it.
  //
  // So the fence is that box plus a margin, and the margin is not decoration.
  // At the intro's own start pose the camera SITS OUTSIDE the data — south-west
  // of the Mixmaster, looking back in — which is what makes the opening frame
  // read as an approach rather than as standing in the middle of things. A
  // fence drawn tight to the bbox would eject the camera on frame one of its
  // own intro.
  //
  //     bbox      -96.8150 .. -96.7800  W-E   (3.28 km)
  //               32.7700 .. 32.7980    S-N   (3.11 km)
  //     margin    0.0060 deg lon (~560 m), 0.0050 deg lat (~555 m)
  //     fence     -96.8210 .. -96.7740, 32.7650 .. 32.8030   (4.4 x 4.2 km)
  //
  // The margin is deliberately larger to the SOUTH-WEST in effect, because that
  // is the only side the camera ever approaches from. Everything past the fence
  // is the basemap: real, but flat and unmodelled, so the fence is "the edge of
  // what this repo built", exactly as Austin's was.
  //
  // If BBOX_* in scripts/config.sh changes, change this with it. There is no
  // way to derive it client-side — the buildings source is the bbox's CONTENTS,
  // not its extent, and a box measured off the contents shrinks to whatever
  // happened to be built near the edge.
  const MODELLED = { w: -96.8210, s: 32.7650, e: -96.7740, n: 32.8030 };

  const JOY_RADIUS = 34, JOY_DEAD = 0.12, JOY_EXPO = 1.6;

  // ── TUNE — the camera FEEL, all in one place ──────────────────────
  // Every value the motion beauty pass added lives here so any of it can be
  // overruled in one line (also live: window.__fly.tune.BANK_MAX = 3).
  // Angles in degrees, times in seconds, distances in metres.
  // All of these are OUTPUT effects: they are derived offsets applied around
  // writeToMap and never mutate the eye/alt/bearing/pitch state, so the
  // arbitration rule and every collision guarantee are untouched.
  const TUNE = {
    BANK_MAX: 5,           // max roll into a turn
    BANK_PER_DEGPS: 0.08,  // deg of roll per deg/s of smoothed yaw rate
    BANK_STRAFE: 1.5,      // deg of lean at full strafe input
    TAU_YAW_RATE: 0.12,    // smoothing on the measured yaw rate
    TAU_BANK_IN: 0.30,     // roll response into a turn
    TAU_BANK_OUT: 0.18,    // roll return to level (reaches <0.05 deg in under 1 s from BANK_MAX)
    YAW_RATE_CLAMP: 240,   // deg/s cap on spikes from coalesced drag events on slow frames
    ROLL_EPS: 0.02,        // below this, with a level target, roll snaps to exactly 0

    // ── The sprint FOV kick, and why it was invisible ────────────────
    // Reported: "sprinting should increase my FOV a bit". The mechanism was
    // already here and already firing — the problem was that it rode ABSOLUTE
    // speed, so ordinary cruising had spent most of it before Shift was
    // touched. Measured on the live build at the spawn pose (fovkick probe,
    // base FOV 58):
    //
    //     idle        58.00        kick 0.00
    //     W           59.59        kick 1.59   (40 m/s — 1/2.5 of sprint)
    //     W + Shift   62.00        kick 4.00   (100 m/s)
    //
    // So pressing Shift bought 2.41 deg of a 4 deg effect: 4% wider frame, at
    // the same moment the whole world starts moving 2.5x faster. Of course it
    // read as "nothing happens".
    //
    // The kick now starts at FOV_KICK_FROM x cruise speed and reaches FOV_KICK
    // at the sprint ceiling, so the WHOLE effect belongs to sprinting and
    // normal flight is at the authored FOV. Same two numbers to overrule.
    FOV_KICK: 7,           // extra vertical FOV at the sprint ceiling
    FOV_KICK_FROM: 1.0,    // speed (as a multiple of cruise) where the kick starts
    TAU_FOV: 0.45,         // FOV ease, both directions
    FOV_EPS: 0.02,         // snap-back-to-base threshold

    BOB_AMP_ALT: 0.45,     // hover-bob altitude amplitude (upward only — never dips below the floor)
    // 0.45 m is invisible at 160 m and is 26% of eye height at 1.7 m — a
    // pronounced bounce. Same for the 0.7 m landing dip, which would take a
    // 1.7 m eye to 1.0 m. Both blend to a ground value on groundMix().
    BOB_AMP_ALT_GROUND: 0.06,
    SETTLE_AMP_GROUND: 0.10,
    BOB_AMP_PITCH: 0.12,   // hover-bob pitch amplitude
    BOB_PERIOD: 5.0,       // hover-bob breathing period
    BOB_MAX_SPEED: 1.5,    // m/s — bob only engages below this horizontal speed
    BOB_TIMEOUT: 8.0,      // s after the last real input the bob is fully wound down (lets `driving` release)
    BOB_FADE: 2.0,         // fade-out tail leading into BOB_TIMEOUT
    TAU_BOB: 0.7,          // bob engage/disengage ease

    SETTLE_AMP: 0.7,       // one-shot dip when arriving at a stop, m
    SETTLE_DUR: 0.9,       // duration of the settle dip
    SETTLE_MIN_SPEED: 12,  // must have been going at least this fast for a settle to fire
    SETTLE_TRIG_SPEED: 2,  // settle fires when speed decays through this

    PITCH_SPEED: 2.0,      // deg of pitch-up (toward the horizon) at full sprint speed; 0 disables
    TAU_PITCH_SPD: 1.2,    // ease into the speed pitch
    TAU_PITCH_SPD_OUT: 0.4,// ease back out (fast, so it never fights the user)
    PITCH_SPD_IDLE: 3.0,   // s without manual pitch input before it may engage

    WALL_TAU: 0.22,        // velocity damping when fully wall-blocked (was: instant zero)
    WALL_STEER: 55,        // deg/s the blocked velocity swings toward the freer side
    WALL_PROBE_AHEAD: 10,  // m ahead for the left/right freer-side probes
    WALL_PROBE_ANGLE: 40,  // deg either side of the motion heading for those probes
  };

  // ── The ground blend ──────────────────────────────────────────────
  // 0 while flying, 1 at the floor, continuous in between. Every pedestrian
  // parameter is a lerp on this and nothing branches on an altitude, so there is
  // no threshold to sit exactly on and no mode to be in the wrong one of.
  // groundMix() is 0 for every altitude at or above ALT_GROUND, which is why the
  // flyover is provably untouched: its lowest scripted pose is 113.9 m.
  const lerp = (a, b, t) => a + (b - a) * t;
  const groundMix = a => clamp((ALT_GROUND - (a == null ? alt : a)) / (ALT_GROUND - ALT_MIN), 0, 1);
  const rCam   = () => lerp(R_CAM,   R_CAM_GROUND,   groundMix());
  const skinV  = () => lerp(SKIN_V,  SKIN_V_GROUND,  groundMix());
  const stepUp = () => lerp(STEP_UP, STEP_UP_GROUND, groundMix());

  // ── State — the camera eye is the truth ───────────────────────────
  const eye = { lng: 0, lat: 0 };
  let alt = 0, altUser = 0, altFloor = 0;
  const vel = { e: 0, n: 0 };
  let bearing = 0, pitch = 0;
  let pendingYaw = 0, pendingPitch = 0, wheelLogAcc = 0, touchLogAcc = 0;  // yaw/pitch in DEGREES
  let lastTs = null, rafId = null, wasDriving = false, simTime = 0;

  const keys = Object.create(null);
  const keyDown = code => !!keys[code];
  let sprintHeld = false;

  let ALT_REF = 230, HOME = null;

  // ── Feel-effect state (derived OUTPUT offsets — never part of the eye) ──
  const ROLL_OK = typeof map.getRoll === 'function' && typeof map.setRoll === 'function';
  const FOV_OK = typeof map.setVerticalFieldOfView === 'function' &&
                 typeof map.getVerticalFieldOfView === 'function';
  const baseFov = () => (window.GFX && typeof window.GFX.fov === 'number') ? window.GFX.fov : 58;
  let yawRate = 0;            // smoothed d(bearing)/dt, deg/s
  let rollNow = 0;            // written to the map each driven frame; MUST be 0 on handback
  let fovKickNow = 0;         // deg above the graphics menu's base FOV
  let bobGain = 0;            // eased 0..1 hover-bob engagement
  let settleT = Infinity;     // time into the one-shot landing settle
  let peakSpeed = 0, prevSpeed = 0;
  let pitchSpdNow = 0;        // deg of speed-adaptive pitch-up
  let lastRealInputT = -1e9, lastPitchInputT = -1e9;   // in simTime seconds
  let fxAltOff = 0, fxPitchOff = 0;   // this frame's output offsets
  let fxLive = false;         // true while any effect still needs to write

  /** Snap every effect to zero and put the map's roll/FOV back to neutral.
   *  Called on every hand-back so external animations always start level. */
  function resetEffectsHard() {
    yawRate = 0; rollNow = 0; fovKickNow = 0; bobGain = 0;
    settleT = Infinity; peakSpeed = 0; prevSpeed = 0; pitchSpdNow = 0;
    fxAltOff = 0; fxPitchOff = 0; fxLive = false;
    if (ROLL_OK && map.getRoll() !== 0) map.setRoll(0);
    if (FOV_OK && Math.abs(map.getVerticalFieldOfView() - baseFov()) > 0.001) {
      map.setVerticalFieldOfView(baseFov());
    }
  }

  // ── Height field ──────────────────────────────────────────────────
  // A dense max-roof grid. Footprints are RASTERISED, not bbox-stamped: a
  // bounding box over-covers a rotated footprint by up to ~13 m at the corners,
  // which would stop you short of exactly the facades you're trying to read.
  let grid = null, gx0 = 0, gy0 = 0, gnx = 0, gny = 0, gridBuilt = false;
  let fence = null;

  function buildHeightField(sc) {
    const feats = [];
    const push = (arr, key) => { for (const f of (arr || [])) {
      const h = f.properties && (f.properties[key]);
      if (h > 0 && f.geometry) feats.push([f.geometry, h]);
    } };
    if (sc) { push(sc.buildings && sc.buildings.features, 'final_height');
              push(sc.parts && sc.parts.features, 'h'); }
    if (!feats.length) { gridBuilt = false; grid = null; return false; }

    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    const rings = [];
    for (const [g, h] of feats) {
      const polys = g.type === 'Polygon' ? [g.coordinates]
                  : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) {
        const r = poly[0];
        if (!r || r.length < 4) continue;
        rings.push([r, h]);
        for (const p of r) {
          if (p[0] < minLng) minLng = p[0]; if (p[0] > maxLng) maxLng = p[0];
          if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1];
        }
      }
    }
    if (!rings.length) { gridBuilt = false; return false; }

    const midLat = (minLat + maxLat) / 2;
    const mx = mLon(midLat), my = M_LAT;
    gx0 = minLng - CELL / mx; gy0 = minLat - CELL / my;
    gnx = Math.ceil(((maxLng - gx0) * mx) / CELL) + 2;
    gny = Math.ceil(((maxLat - gy0) * my) / CELL) + 2;
    grid = new Float32Array(gnx * gny);

    const cx = lng => (lng - gx0) * mx / CELL;
    const cy = lat => (lat - gy0) * my / CELL;
    const stamp = (i, j, h) => {
      if (i < 0 || j < 0 || i >= gnx || j >= gny) return;
      const k = j * gnx + i;
      if (grid[k] < h) grid[k] = h;
    };

    for (const [ring, h] of rings) {
      const xs = ring.map(p => cx(p[0])), ys = ring.map(p => cy(p[1]));
      let j0 = Math.floor(Math.min.apply(null, ys)), j1 = Math.ceil(Math.max.apply(null, ys));
      j0 = Math.max(0, j0); j1 = Math.min(gny - 1, j1);
      // (a) scanline fill through each cell-row centre
      for (let j = j0; j <= j1; j++) {
        const yc = j + 0.5, xsAt = [];
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const ya = ys[a], yb = ys[b];
          if ((ya > yc) === (yb > yc)) continue;
          xsAt.push(xs[a] + (yc - ya) / (yb - ya) * (xs[b] - xs[a]));
        }
        xsAt.sort((p, q) => p - q);
        for (let s = 0; s + 1 < xsAt.length; s += 2) {
          const i0 = Math.max(0, Math.floor(xsAt[s])), i1 = Math.min(gnx - 1, Math.ceil(xsAt[s + 1]));
          for (let i = i0; i <= i1; i++) stamp(i, j, h);
        }
      }
      // (b) edge walk at half-cell steps so slivers are never missed
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const dx = xs[a] - xs[b], dy = ys[a] - ys[b];
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 2));
        for (let s = 0; s <= steps; s++) {
          stamp(Math.floor(xs[b] + dx * s / steps), Math.floor(ys[b] + dy * s / steps), h);
        }
      }
    }

    const padLng = FENCE_PAD / mx, padLat = FENCE_PAD / my;
    // The UNION of the two, never just the wider one: the modelled box is where
    // the city is, the buildings box is where the collision grid is, and a
    // fence that did not contain the grid would let a snapshot that grew past
    // the ring's edge put buildings outside the flyable area.
    fence = {
      w: Math.min(minLng, MODELLED.w) - padLng,
      s: Math.min(minLat, MODELLED.s) - padLat,
      e: Math.max(maxLng, MODELLED.e) + padLng,
      n: Math.max(maxLat, MODELLED.n) + padLat,
    };
    gridBuilt = true;
    return true;
  }

  // ── The outer collision field ─────────────────────────────────────
  //
  // The grid above is rasterised from `scene.buildings`, which is 10 km2 of a
  // city the fence now lets you fly 77 km2 of. Everything the widening opened
  // up -- all of downtown, every tower in it, up to 315 m of Sixth &
  // Guadalupe -- is drawn by js/outer.js off a TILED source, and a tiled source
  // has no complete feature list to rasterise at load. The browser only holds
  // the tiles it has drawn.
  //
  // Widening the fence without this would let the camera fly straight through
  // the Independent, which is a worse defect than the one being fixed. So it is
  // built the only way a tiled source allows: incrementally, from whatever the
  // source is currently holding, every time the map settles. Flying at a tower
  // means looking at it, which means its tile is loaded, which means it is in
  // here before you arrive.
  //
  // BOUNDING BOXES, NOT RASTERISED FOOTPRINTS, and here that is right rather
  // than lazy. HANDOFF §50 is about SIZING something from a bbox, where
  // over-covering a rotated footprint by ~13 m puts a handrail off the roof.
  // For a collision net over-covering stops you slightly EARLY, which is the
  // safe direction. The core grid scanline-fills because there you want to fly
  // up to a facade and read it; out here you want to not go through it.
  //
  // Sparse, so its memory is the built-up fraction rather than the box: a dense
  // Float32Array over the new fence at CELL would be 8.8 MB for a field that is
  // mostly empty.
  const OUTER_SRC = 'city-outer';
  const OUTER_CELL = 10;          // m. Coarser than CELL: a bbox is coarse anyway
  // Nothing under this can be hit. ALT_MIN is 18 m and blockedAt fires at
  // height + SKIN > alt, so a 12 m building never blocks, and skipping them
  // keeps two-storey West Campus houses from stamping a solid slab over every
  // block for no benefit. It also cuts the work by roughly an order of
  // magnitude -- of 8,428 ring buildings only 192 are over 60 m.
  const OUTER_MIN_H = 12;
  // ...and that reasoning dies with the 18 m floor. At walking height a 12 m cut
  // is a hole you can walk through: 7,652 of the ring's 9,149 buildings are 12 m
  // or under, i.e. EVERYTHING off campus that is not a tower — a first-time
  // visitor on a West Campus pavement walking through a house. So the cut is
  // altitude-gated, and crossing ALT_GROUND forces a rescan (outerSeen only holds
  // what was ADDED, so the low-rise skipped while flying is not deduped away).
  // The campus snapshot itself is unaffected: all 2,453 of its buildings, down to
  // 1.7 m, are already rasterised into the core grid.
  const OUTER_MIN_H_GROUND = 2.5;
  const OUTER_RESCAN_M = 200;     // rescan once the camera has moved this far
  const OUTER_RESCAN_MS = 1500;   // ...or this long, whichever comes first
  // A HARD BUDGET, IN MILLISECONDS, and it is the difference between this
  // costing nothing and it dropping a frame. Measured before it existed:
  // 8.9 ms average per scan and a 35.1 ms WORST, which at 60 fps is two frames
  // gone — the kind of thing that gets reported as "it stutters sometimes" and
  // is never found. The scan resumes where it left off, so a budget delays the
  // field rather than truncating it, and the throttle above means the next
  // instalment is at most 1.5 s away.
  const OUTER_BUDGET_MS = 4;
  let outerCells = new Map(), outerScanAt = 0, outerScanLng = 0, outerScanLat = 0;
  let outerSeen = new Set(), outerPending = null, outerPendingAt = 0;
  let outerIdleBackoff = false, outerAddedThisPass = 0, outerMinHUsed = OUTER_MIN_H;
  const outerMinH = () => (alt < ALT_GROUND ? OUTER_MIN_H_GROUND : OUTER_MIN_H);
  let outerFeatures = 0, outerScans = 0, outerScanMs = 0, outerScanMsMax = 0;

  const outerKey = (i, j) => i * 1048576 + j;

  function outerStamp() {
    const my = M_LAT;
    const t0 = performance.now();

    // Resume an unfinished list before asking for a new one. Without this a
    // budget would just re-do the first few hundred features forever.
    if (!outerPending || outerPendingAt >= outerPending.length) {
      if (!map.getSource || !map.getSource(OUTER_SRC)) return;
      // The source is a vector tile source when data/tiles/ is present and a
      // geojson source when it is not (window.TILES falls back silently), and
      // the two want different arguments. Ask for both rather than duplicating
      // tiles.js's fallback rule here, where it would go stale.
      //
      // The FILTER is not a nicety: it makes MapLibre drop the low-rise before
      // it builds the feature objects, and the low-rise is most of the ring.
      const layer = (window.TILES && window.TILES.layers && window.TILES.layers.outer
                     && window.TILES.layers.outer.layer) || 'outer';
      const filter = ['>', ['get', 'h'], outerMinHUsed];
      let feats = [];
      try { feats = map.querySourceFeatures(OUTER_SRC, { sourceLayer: layer, filter }); } catch (e) {}
      if (!feats.length) {
        try { feats = map.querySourceFeatures(OUTER_SRC, { filter }); } catch (e) {}
      }
      if (!feats.length) return;
      outerPending = feats; outerPendingAt = 0;
      outerAddedThisPass = 0;
    }

    while (outerPendingAt < outerPending.length) {
      // Check the clock every 64 features rather than every one: at ~2 us of
      // work per feature, performance.now() itself would be most of the cost.
      if ((outerPendingAt & 63) === 0 && performance.now() - t0 > OUTER_BUDGET_MS) return;
      const f = outerPending[outerPendingAt++];
      const h = f.properties && f.properties.h;
      if (!(h > outerMinHUsed) || !f.geometry) continue;
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates]
                  : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      for (const poly of polys) {
        const r = poly[0];
        if (!r || r.length < 4) continue;
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const p of r) {
          if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0];
          if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1];
        }
        // The SAME building arrives again in every later scan, and in every
        // neighbouring tile that overlaps it. Position plus height is a stable
        // identity across all of those; the feature `id` is not, because the
        // GeoJSON fallback path has none.
        const key = ((w * 1e5) | 0) + ':' + ((s * 1e5) | 0) + ':' + (h | 0);
        if (outerSeen.has(key)) continue;
        outerSeen.add(key);
        const mx = mLon((s + n) / 2);
        const i0 = Math.floor(w * mx / OUTER_CELL), i1 = Math.floor(e * mx / OUTER_CELL);
        const j0 = Math.floor(s * my / OUTER_CELL), j1 = Math.floor(n * my / OUTER_CELL);
        // A guard, not a limit: a corrupt coordinate could otherwise ask for a
        // million cells and freeze the frame it happens on.
        if ((i1 - i0) > 400 || (j1 - j0) > 400) continue;
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            const k = outerKey(i, j);
            if (!(outerCells.get(k) >= h)) outerCells.set(k, h);
          }
        }
        outerFeatures++; outerAddedThisPass++;
      }
    }
    // The list ran out: this pass saw every feature the source is holding.
    outerIdleBackoff = outerAddedThisPass === 0;
  }

  /** Max ring-building height within r metres, from the incremental field. */
  function outerHeightIn(lng, lat, r) {
    if (!outerCells.size) return 0;
    const mx = mLon(lat), my = M_LAT;
    const i0 = Math.floor((lng - r / mx) * mx / OUTER_CELL);
    const i1 = Math.floor((lng + r / mx) * mx / OUTER_CELL);
    const j0 = Math.floor((lat - r / my) * my / OUTER_CELL);
    const j1 = Math.floor((lat + r / my) * my / OUTER_CELL);
    let best = 0;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const v = outerCells.get(outerKey(i, j));
        if (v > best) best = v;
      }
    }
    return best;
  }

  function outerMaybeScan() {
    const now = simTime;
    // An unfinished list resumes on the NEXT frame, not on the next throttle
    // window. Otherwise a big instalment queue would trickle in at 4 ms every
    // 1.5 s and the camera could reach a tower before the tower reached the
    // field — which is the one failure this whole mechanism exists to prevent.
    if (outerMinH() !== outerMinHUsed) {
      outerMinHUsed = outerMinH();
      outerPending = null; outerScanAt = 0; outerIdleBackoff = false;
    }
    const resuming = outerPending && outerPendingAt < outerPending.length;
    const moved = Math.hypot((eye.lng - outerScanLng) * mLon(eye.lat),
                             (eye.lat - outerScanLat) * M_LAT);
    // BACK OFF WHEN THERE IS NOTHING NEW. querySourceFeatures is the one part
    // of this that cannot be budgeted — it builds the whole feature list before
    // it returns, measured at up to 12.5 ms — so the cheapest saving available
    // is not making the call. Sitting still over a district already stamped
    // asks every 6 s instead of every 1.5; moving 200 m still forces it, so
    // arriving somewhere new is never delayed.
    const wait = outerIdleBackoff ? OUTER_RESCAN_MS * 4 : OUTER_RESCAN_MS;
    if (!resuming && outerScanAt && moved < OUTER_RESCAN_M
        && (now - outerScanAt) * 1000 < wait) return;
    outerScanAt = now || 1e-6;
    outerScanLng = eye.lng; outerScanLat = eye.lat;
    // TIMED, because this is the one thing in the tick that is not O(1) and a
    // scan that hitches one frame in ninety is exactly the kind of thing that
    // gets described as "it stutters sometimes" and never found.
    const t = performance.now();
    outerStamp();
    const ms = performance.now() - t;
    outerScans++; outerScanMs += ms;
    if (ms > outerScanMsMax) outerScanMsMax = ms;
  }

  // ── The trunk field ───────────────────────────────────────────────
  //
  // 7,559 tree trunks, and until now you walked through every single one. At the
  // old 18 m floor that was invisible. At 1.7 m the campus and West Campus
  // streets are full of trees and walking through a live oak is the quickest way
  // there is to stop believing the city.
  //
  // TRUNKS ONLY, AND THAT IS THE WHOLE DESIGN, not a first instalment. Real
  // people walk under trees all day; a canopy you cannot enter would read as a
  // worse fault than one you can. The crowns are also enormous next to a person
  // — a median crown is 4.27 m of radius against a 1.0 m probe — so putting them
  // in a collision field would wall off every tree-lined path on campus,
  // starting with the South Mall.
  //
  // IT IS ITS OWN FIELD RATHER THAN A FEW MORE CELLS IN maxHeightIn, and that is
  // not a structural preference. It is the difference between working and not:
  //
  //   * maxHeightIn answers "how high is the ROOF here", and every one of its
  //     six readers treats the answer as something you can stand ON. Feed it a
  //     trunk and the step-up branch reads a 4.95 m oak as a kerb, the rooftop
  //     floor lifts the camera onto it, and the hard net parks you at
  //     trunk + HARD_CLEAR. You would ride the trees instead of walking round
  //     them — which is exactly the failure §105 fixed for two-storey houses.
  //   * its cell is 6 m. The median trunk is 0.48 m across the radius; stamped
  //     into a 6 m cell it becomes a 6 m obstacle, and the South Mall's rows are
  //     planted 6-8 m apart. The mall would close.
  //
  // So a trunk is a CIRCLE, tested exactly. The bucket grid below only narrows
  // the candidate list; the blocking test is always the real measured radius.
  //
  // Cost. `blockedAt` runs up to three times per substep and this rides along
  // with it, so it has to be genuinely O(1): one Map.get and a walk of a
  // five-number record per candidate, and the candidates in a bucket are the two
  // or three trees standing in an 8 m square. Above TRUNK_ALT it is a single
  // compare and a return, so the flyover pays for a branch and nothing else.
  const TRUNK_SRC = 'city-trees';
  // ── Taste and limits. Every one of these is a one-line overrule. ──
  const TRUNK_ON = true;        // false restores walking through trees exactly
  // ── TRUNK_PAD is 0.9 and the reason is the NEAR PLANE, not personal space ──
  //
  // MapLibre's near plane is `canvasHeight / 50` pixels, and dividing by
  // transform.pixelsPerMeter (= camPx / D) turns that into metres:
  //
  //     nearZ = D * 2 * tan(fov/2) / 50 = 0.0222 * D        (fov 58)
  //
  // — viewport-independent, and MEASURED at 0.72 m for both 800x600 and
  // 1280x800 at 1.7 m eye / pitch 87, where D = 32.5 m. Anything closer than
  // that is clipped away, and because MapLibre back-face-culls fill-extrusions,
  // clipping the near face of a trunk does not reveal its inside — IT REVEALS
  // WHAT IS BEHIND IT. The tree stops existing.
  //
  // Photographed: stop the camera 0.6 m off the bark and the oak you just
  // walked into is not in the frame. That is the collision working and looking
  // like a bug, which is worse than the defect it fixes. At 0.9 m the bark
  // stays outside the near plane for every pitch up to ~87.5 deg and the tree is
  // there when you stop. It is also the same mechanism as the canopy
  // disappearing when you enter it (HANDOFF §108) — one clip rule, two symptoms.
  const TRUNK_PAD = 0.9;        // m of clearance kept outside the bark
  const TRUNK_CLEAR = 0.5;      // m of headroom; above trunk top + this you pass
  const TRUNK_R_MIN = 0.2, TRUNK_R_MAX = 1.2;   // clamp on the measured radius
  const TRUNK_BUCKET = 8;       // m — candidate buckets, NOT the blocking radius
  const TRUNK_BUDGET_MS = 3;    // same hard budget rule as the outer scan
  const TRUNK_RESCAN_M = 60;    // trees are local; rescan sooner than the ring
  const TRUNK_RESCAN_MS = 1500; // floor between two querySourceFeatures calls
  // Above this, nothing is scanned and nothing is tested. The TALLEST trunk in
  // data/trees.geojson is 10.63 m, so at ALT_GROUND (12) no trunk could block
  // anyway: this gate removes work, it never removes a block, and there is
  // therefore no altitude at which it can pop. Nothing scripted goes below
  // 113.9 m, so the intro, the tour and the default pose never touch any of it.
  const TRUNK_ALT = ALT_GROUND;

  let trunkBuckets = new Map(), trunkSeen = new Set();
  let trunkPending = null, trunkPendingAt = 0;
  let trunkScanAt = 0, trunkScanLng = 0, trunkScanLat = 0;
  let trunkDirty = true, trunkAddedThisPass = 0;
  let trunkCount = 0, trunkScans = 0, trunkScanMs = 0, trunkScanMsMax = 0;
  let trunkStuck = false;
  const trunkKey = (i, j) => i * 1048576 + j;
  const treeDensity = () => ((window.GFX && typeof window.GFX.treeDensity === 'number')
                             ? window.GFX.treeDensity : 1);

  // THE ONLY WAY A NEW TRUNK CAN APPEAR IS A NEW TILE, so that is the trigger.
  // The first draft polled every 1.5 s forever, and measured on this laptop that
  // is 12.3 ms of querySourceFeatures on average and a 123 ms WORST — seven
  // dropped frames, repeating, for a field that had already finished. The call
  // cannot be budgeted (it builds its whole feature list before returning; the
  // outer ring has the same problem, written up as QUEUE Y7), so the only saving
  // available is not making it. Now a scan happens when a tile lands, when the
  // camera has moved TRUNK_RESCAN_M, or when there is an unfinished list — and
  // standing still in a district that is already stamped costs nothing at all.
  //
  // ATTACHED LAZILY, the first time the camera drops below TRUNK_ALT, and never
  // detached after that. `sourcedata` is one of MapLibre's noisiest events —
  // every tile state change on every source fires it — and a flyover that never
  // lands should not be dispatching into this file at all. With the lazy attach
  // the intro, the tour and the default pose register nothing, call nothing and
  // allocate nothing: the whole feature is one `alt >= TRUNK_ALT` compare.
  let trunkListening = false;
  const onTrunkSourceData = e => {
    if (e && e.sourceId === TRUNK_SRC && e.tile) trunkDirty = true;
  };

  /** One instalment of the incremental trunk scan. Mirrors outerStamp(). */
  function trunkStamp() {
    const my = M_LAT;
    const t0 = performance.now();

    if (!trunkPending || trunkPendingAt >= trunkPending.length) {
      if (!map.getSource || !map.getSource(TRUNK_SRC)) return;
      const layer = (window.TILES && window.TILES.layers && window.TILES.layers.trees
                     && window.TILES.layers.trees.layer) || 'trees';
      // KIND ONLY — the tree-DENSITY half of the layer's filter is deliberately
      // not applied here. It is applied per record at query time instead (`d`
      // is stamped alongside the geometry), because density is a live setting:
      // the graphics preset moves it at load and the auto-detect probe can move
      // it again ~11 s later. Filtering at scan time means every change throws
      // the field away and leaves a WINDOW WITH NO TREE COLLISION AT ALL while
      // it rebuilds — measured, and it is several seconds long right at the
      // moment a first-time visitor starts walking. Filtering at query time
      // makes a density change free and exact in the same frame.
      const filter = ['==', ['get', 'kind'], 'trunk'];
      let feats = [];
      try { feats = map.querySourceFeatures(TRUNK_SRC, { sourceLayer: layer, filter }); } catch (e) {}
      if (!feats.length) {
        try { feats = map.querySourceFeatures(TRUNK_SRC, { filter }); } catch (e) {}
      }
      if (!feats.length) return;
      trunkPending = feats; trunkPendingAt = 0; trunkAddedThisPass = 0;
    }

    while (trunkPendingAt < trunkPending.length) {
      if ((trunkPendingAt & 63) === 0 && performance.now() - t0 > TRUNK_BUDGET_MS) return;
      const f = trunkPending[trunkPendingAt++];
      const h = f.properties && f.properties.h;
      if (!(h > 0) || !f.geometry) continue;
      // `d` is the bake's keep-order in 0..1 (small trees first), the same
      // number js/app.js:treeFilter thins on. Absent means always drawn.
      const dOrd = (f.properties && typeof f.properties.d === 'number') ? f.properties.d : 0;
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates]
                  : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      for (const poly of polys) {
        const r = poly[0];
        if (!r || r.length < 4) continue;
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const p of r) {
          if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0];
          if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1];
        }
        const cLng = (w + e) / 2, cLat = (s + n) / 2;
        // Position is the identity, as in the outer field: the same trunk comes
        // back on every later scan and from every neighbouring tile.
        const key = ((cLng * 1e6) | 0) + ':' + ((cLat * 1e6) | 0);
        if (trunkSeen.has(key)) continue;
        trunkSeen.add(key);
        const mx = mLon(cLat);
        // MEASURED off the polygon, never assumed. The bake draws every trunk at
        // its own diameter — 0.24 to 0.91 m of radius, median 0.48 — so one
        // fixed number would be wrong at both ends of the range.
        const rawR = Math.max((e - w) * mx, (n - s) * my) / 2;
        const rb = clamp(rawR, TRUNK_R_MIN, TRUNK_R_MAX) + TRUNK_PAD;
        const i0 = Math.floor((cLng - rb / mx) * mx / TRUNK_BUCKET);
        const i1 = Math.floor((cLng + rb / mx) * mx / TRUNK_BUCKET);
        const j0 = Math.floor((cLat - rb / my) * my / TRUNK_BUCKET);
        const j1 = Math.floor((cLat + rb / my) * my / TRUNK_BUCKET);
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            const k = trunkKey(i, j);
            let a = trunkBuckets.get(k);
            if (!a) { a = []; trunkBuckets.set(k, a); }
            a.push(cLng, cLat, rb, h, dOrd);       // flat records of five
          }
        }
        trunkCount++; trunkAddedThisPass++;
      }
    }
    // The list ran out: this pass saw every trunk the source is holding.
    trunkPending = null; trunkDirty = false;
  }

  function trunkMaybeScan() {
    // TWO EARLY RETURNS AND THEY ARE THE PERFORMANCE STORY. Flying costs one
    // compare per frame: no querySourceFeatures, no stamping, no allocation.
    if (!TRUNK_ON || alt >= TRUNK_ALT) return;
    if (!trunkListening) { map.on('sourcedata', onTrunkSourceData); trunkListening = true; }
    const now = simTime;
    const resuming = trunkPending && trunkPendingAt < trunkPending.length;
    const moved = Math.hypot((eye.lng - trunkScanLng) * mLon(eye.lat),
                             (eye.lat - trunkScanLat) * M_LAT);
    if (!resuming && !trunkDirty && trunkScanAt && moved < TRUNK_RESCAN_M) return;
    // An unfinished list resumes on the very next frame; everything else waits
    // out the floor, so a burst of arriving tiles is one scan and not twelve.
    if (!resuming && trunkScanAt && (now - trunkScanAt) * 1000 < TRUNK_RESCAN_MS) return;
    trunkScanAt = now || 1e-6;
    trunkScanLng = eye.lng; trunkScanLat = eye.lat;
    const t = performance.now();
    trunkStamp();
    const ms = performance.now() - t;
    trunkScans++; trunkScanMs += ms;
    if (ms > trunkScanMsMax) trunkScanMsMax = ms;
  }

  /** Is (lng, lat) inside a trunk's blocking circle for an eye at `a` metres? */
  function trunkAt(lng, lat, a) {
    if (!TRUNK_ON || !trunkBuckets.size) return false;
    a = a == null ? alt : a;
    if (a >= TRUNK_ALT) return false;
    const mx = mLon(lat), my = M_LAT;
    const arr = trunkBuckets.get(trunkKey(Math.floor(lng * mx / TRUNK_BUCKET),
                                          Math.floor(lat * my / TRUNK_BUCKET)));
    if (!arr) return false;
    const dens = treeDensity();
    for (let k = 0; k < arr.length; k += 5) {
      if (a >= arr[k + 3] + TRUNK_CLEAR) continue;    // the eye clears the top
      if (arr[k + 4] > dens) continue;                // thinned away, not drawn
      const de = (lng - arr[k]) * mx, dn = (lat - arr[k + 1]) * my;
      if (de * de + dn * dn < arr[k + 2] * arr[k + 2]) return true;
    }
    return false;
  }

  /**
   * The movement-time test, and the difference from trunkAt is the escape hatch.
   *
   * Block-and-slide has no way out of a solid it is already inside: every
   * direction is blocked, so the camera would be welded to the spot forever.
   * Buildings never hit this because you cannot walk into one — but a trunk is
   * 1.5 m across, and a scripted pose, an R reset or a field that finished
   * stamping while you happened to be standing there can all drop the camera
   * inside one. So if you are ALREADY in a trunk, trunks do not block this
   * frame and you simply walk out. Trapping the user is worse than the defect.
   */
  const trunkBlockedAt = (lng, lat, a) => !trunkStuck && trunkAt(lng, lat, a);

  /** Max indexed roof height within r metres of a ground position.
   *
   * THE ONE CHOKE POINT. Block-and-slide, the rooftop floor, the speed brake,
   * the wall deflection and writeToMap's hard net all read the world through
   * this function and nothing else, so teaching it about the outer ring gives
   * every one of them downtown collision for free. That is why the ring goes in
   * here rather than into a parallel check at each call site.
   */
  function maxHeightIn(lng, lat, r) {
    r = r == null ? rCam() : r;
    const ring = outerHeightIn(lng, lat, r);
    if (!gridBuilt) return ring;
    const mx = mLon(lat), my = M_LAT;
    const i0 = Math.floor((lng - r / mx - gx0) * mx / CELL);
    const i1 = Math.floor((lng + r / mx - gx0) * mx / CELL);
    const j0 = Math.floor((lat - r / my - gy0) * my / CELL);
    const j1 = Math.floor((lat + r / my - gy0) * my / CELL);
    let best = ring;
    for (let j = Math.max(0, j0); j <= Math.min(gny - 1, j1); j++) {
      const row = j * gnx;
      for (let i = Math.max(0, i0); i <= Math.min(gnx - 1, i1); i++) {
        const v = grid[row + i];
        if (v > best) best = v;
      }
    }
    return best;
  }

  // ── Derived bounds. These BLOCK input; they never move the camera. ──
  // The derived zoom falls as pitch rises (the point at screen centre really is
  // further away), so the zoom limits have to show up as limits on altitude and
  // pitch. Doing it the other way — nudging the camera toward a legal pose —
  // would mean the view moves without the user asking, which is the exact
  // failure this rewrite exists to remove.
  const dMax = () => camPx() * mpp(ZOOM_MIN, eye.lat);
  const altCeiling = () => Math.min(ALT_MAX, dMax() * Math.cos(rad(pitch)));

  // DO NOT WIDEN THIS. It looks like a needless restriction and it is not.
  //
  // The eye is the state and zoom is DERIVED from it: z comes from
  // D = alt/cos(pitch), and z is clamped to ZOOM_MIN. pitchCap is exactly the
  // pitch at which that clamp is about to bite — acos(alt/dMax) is the same
  // equation solved for pitch. Allow more, and the derived zoom saturates while
  // the centre keeps travelling, so the EYE moves even though nothing asked it
  // to.
  //
  // That is not theory. A previous pass multiplied dMax here by 2.8 to let the
  // camera look up while high, shipped it, and the report back was that looking
  // up TELEPORTED the camera to the edge of the map and looking back down
  // returned it. Reproduced and measured below by scripts/verify/lookup-check.mjs:
  // at 450 m the eye jumped 5.6 km.
  //
  // Looking up while high therefore needs a lower ZOOM_MIN, not a wider cap —
  // and that re-budgets every zoom in the app (most layers start at minzoom 14),
  // so it is its own pass with its own verification.
  const pitchCap = () => Math.min(PITCH_MAX, deg(Math.acos(clamp(alt / dMax(), 0, 1))));

  // ── THE SAME TRAP AT THE OTHER END OF THE ZOOM RANGE ──────────────
  //
  // ZOOM_MAX bounds the derived zoom from above exactly as ZOOM_MIN bounds it
  // from below, so there is a SMALLEST camera-to-centre distance the pose can
  // express — 18.47 m at 1440x900 / fov 58. Since alt = D*cos(pitch), a low
  // camera that pitches down asks for a D under that, the clamp bites, and
  // MapLibre places the camera 18.47 m from the centre instead of the 2 m it was
  // asked for: THE EYE SLIDES BACKWARDS AND UPWARDS ALONG ITS OWN VIEW RAY while
  // window.__fly.eye() keeps truthfully reporting 1.7 m, because the eye state
  // really is 1.7 m. It is the render that lies. This is the identical failure to
  // the look-up teleport documented at DO NOT WIDEN THIS above, mirrored — and it
  // is live TODAY at the old 18 m floor in the pitch 5-13 deg band, where nobody
  // ever flies.
  //
  // pitchFloorAt is that clamp solved for pitch, the exact mirror of pitchCap's
  // acos(alt/dMax). It BLOCKS INPUT rather than moving the camera, which is the
  // rule this whole section already runs on. Consequence, and it is a real
  // restriction to be honest about: at 1.7 m the pose is only expressible at
  // pitch >= 84.7 deg, so at walking height you may look level and up but NOT
  // down at your own feet. It relaxes continuously as you climb and is exactly
  // zero at and above 18.47 m, so no scripted pose in this app ever sees it.
  //
  // THE ALTERNATIVE WAS MEASURED, IT WORKS, AND IT IS STILL NOT TAKEN.
  // Raising ZOOM_MAX past MapLibre's default maxZoom of 22 would remove this
  // restriction entirely (1.7 m at nadir needs 24.9). Probed on the vendored
  // 5.24 rather than assumed, because this file's own history is setMaxPitch(120)
  // being accepted and silently still doing 90: setMaxZoom(22.5/23/24/25/26) are
  // ALL accepted and all report back exactly what they were given, and a jumpTo
  // to z24.2 really arrives — transform.pixelsPerMeter 285.45 against
  // cameraToCenterDistance 811.82 px is a genuine 2.84 m camera.
  //
  // What stops it is not the library, it is a layer: `js/ground.js:349`
  // `texGroundMaxZoom: 22` is a LAYER maxzoom, so the textured ground stops being
  // drawn above z22 — and z only climbs past 22 when you pitch DOWN at low
  // altitude, i.e. exactly when you are looking at the ground. Trading "you
  // cannot look at your feet" for "your feet have no texture" is not a trade.
  // Blocking the input costs one layer nothing and stays inside this file.
  // Written up as a QUEUE item; it is a ground.js pass, not a controls.js one.
  const dMin = () => camPx() * mpp(ZOOM_MAX, eye.lat);
  const pitchFloorAt = a => deg(Math.acos(clamp(a / dMin(), 0, 1)));
  const pitchFloor = () => Math.max(PITCH_MIN, pitchFloorAt(alt));
  // See LOOK.PITCH_SPAN_PX. Reads the SAME two functions the tick clamps
  // against, so the fitted sensitivity and the stop can never drift apart.
  const pitchSens = (touch) => {
    const authored = touch ? SENS_PITCH_TOUCH : SENS_PITCH_MOUSE;
    const lo = pitchFloor(), hi = Math.max(lo, pitchCap());
    const fitted = (hi - lo) / LOOK.PITCH_SPAN_PX;
    return fitted < authored ? fitted : authored;
  };
  // The same constraint read as an altitude. Used by EVERY altitude clamp in the
  // tick, including the one `driving` is tested against — if the drive test and
  // the settle clamp disagreed by so much as a metre the controller would own the
  // camera forever and stomp on the intro.
  const altFloorMin = () => Math.max(ALT_MIN, dMin() * Math.cos(rad(pitch)));

  // ── Read/write the MapLibre pose ──────────────────────────────────
  function syncFromMap() {
    const c = map.getCenter();
    bearing = map.getBearing();
    pitch = clamp(map.getPitch(), PITCH_MIN, PITCH_MAX);
    const D = camPx() * mpp(map.getZoom(), c.lat);
    alt = D * Math.cos(rad(pitch));
    const lead = D * Math.sin(rad(pitch));
    eye.lat = c.lat - lead * Math.cos(rad(bearing)) / M_LAT;
    eye.lng = c.lng - lead * Math.sin(rad(bearing)) / mLon(eye.lat);
    altUser = alt; altFloor = 0;
    vel.e = 0; vel.n = 0;
    pendingYaw = pendingPitch = wheelLogAcc = touchLogAcc = 0;
  }

  let lastWrite = null;
  function writeToMap() {
    // The feel effects (hover bob, landing settle, speed pitch, bank roll) are
    // applied HERE, as derived output offsets on top of the eye state. The eye,
    // alt, bearing and pitch state stay exactly what the movement and collision
    // systems computed, so every guarantee they make still holds.
    let outAlt = alt + fxAltOff;
    if (gridBuilt) {
      const h = maxHeightIn(eye.lng, eye.lat, rCam());
      if (h > 0) outAlt = Math.max(outAlt, h + HARD_CLEAR);   // an offset may never dip below the hard net
    }
    outAlt = Math.max(outAlt, ALT_RENDER_MIN);
    // Both bounds are widened to include `pitch` itself so the clamp can never
    // be inverted by a feel offset; the effects may not push the written pitch
    // outside what the written ALTITUDE can express, in either direction.
    const outPitch = clamp(pitch + fxPitchOff,
                           Math.min(pitch, Math.max(PITCH_MIN, pitchFloorAt(outAlt))),
                           Math.max(pitch, Math.min(PITCH_MAX, pitchCap())));
    const lead = outAlt * Math.tan(rad(outPitch));
    const cLat = eye.lat + lead * Math.cos(rad(bearing)) / M_LAT;
    const cLng = eye.lng + lead * Math.sin(rad(bearing)) / mLon(eye.lat);
    const D = outAlt / Math.cos(rad(outPitch));
    const z = clamp(Math.log2(C * Math.cos(rad(cLat)) * camPx() / (512 * D)), ZOOM_MIN, ZOOM_MAX);
    if (lastWrite &&
        Math.abs(lastWrite.lng - cLng) < 1e-9 && Math.abs(lastWrite.lat - cLat) < 1e-9 &&
        Math.abs(lastWrite.z - z) < 1e-4 && Math.abs(lastWrite.b - bearing) < 1e-4 &&
        Math.abs(lastWrite.p - outPitch) < 1e-4 &&
        Math.abs((lastWrite.r || 0) - rollNow) < 1e-3) return;
    lastWrite = { lng: cLng, lat: cLat, z, b: bearing, p: outPitch, r: rollNow };
    // eventData {fly:true} lets other modules ignore camera events we caused.
    const pose = { center: [cLng, cLat], zoom: z, bearing, pitch: outPitch };
    // jumpTo without `roll` KEEPS the current roll (measured on the vendored
    // 5.24), so roll must be written explicitly every frame it is non-neutral
    // and explicitly zeroed on hand-back (resetEffectsHard).
    if (ROLL_OK) pose.roll = rollNow;
    map.jumpTo(pose, { fly: true });
  }

  // ── Collision ─────────────────────────────────────────────────────
  //
  // THE `h > 0` IS NOT DEFENSIVE, IT IS THE BUG. maxHeightIn returns 0 over open
  // ground, and `0 + SKIN(2.5) > alt` is TRUE for every altitude under 2.5 m —
  // so at a 1.7 m floor every cell in Austin, including the middle of the South
  // Mall, reported "blocked", and the step-up branch then read that as a kerb and
  // lifted the camera to SKIN_V. Press W on grass, rise to 8 m. Three sites had
  // this unguarded comparison (here, speedBrake, wallDeflect's probes); the three
  // that already guarded on `h > 0` are the hard net, the rooftop floor and
  // writeToMap. This makes all six agree.
  const blocks = (h, a) => h > 0 && h + SKIN > a;
  const blockedAt = (lng, lat) => blocks(maxHeightIn(lng, lat, rCam()), alt);
  // Roofs OR trunks, for the two slide branches — the only places that ask
  // "could I go this way at all" rather than "how high is it here".
  const hardBlockedAt = (lng, lat) =>
    trunkBlockedAt(lng, lat) || (gridBuilt && blockedAt(lng, lat));

  /**
   * Wall deflection (TUNE.WALL_*): called when a substep found the way blocked.
   * Damps the blocked velocity component(s) over ~WALL_TAU instead of zeroing
   * them instantly, and swings the velocity toward whichever side of the
   * heading has more clearance, so hitting a facade reads as a deflection that
   * slips down the street rather than a face-plant. Positions are NEVER
   * advanced here — only the free axis is applied by the caller — so this
   * cannot introduce penetration; the block-and-slide guarantee is untouched.
   */
  function wallDeflect(sdt, eBlk, nBlk) {
    const f = Math.exp(-sdt / TUNE.WALL_TAU);
    if (eBlk) vel.e *= f;
    if (nBlk) vel.n *= f;
    const spB = Math.hypot(vel.e, vel.n);
    if (spB < 0.02) { if (eBlk && nBlk) { vel.e = 0; vel.n = 0; } return; }
    const hd = Math.atan2(vel.e, vel.n);           // motion heading, rad from north
    const pa = rad(TUNE.WALL_PROBE_ANGLE);
    const probe = a => maxHeightIn(
      eye.lng + Math.sin(a) * TUNE.WALL_PROBE_AHEAD / mLon(eye.lat),
      eye.lat + Math.cos(a) * TUNE.WALL_PROBE_AHEAD / M_LAT, rCam());
    const hL = probe(hd - pa), hR = probe(hd + pa);
    const freeL = !blocks(hL, alt), freeR = !blocks(hR, alt);
    let rot = 0;                                   // + rotates the velocity clockwise (to the right)
    if (freeR && !freeL)      rot =  rad(TUNE.WALL_STEER) * sdt;
    else if (freeL && !freeR) rot = -rad(TUNE.WALL_STEER) * sdt;
    else if (hL !== hR) rot = (hR < hL ? 1 : -1) * rad(TUNE.WALL_STEER) * sdt;
    if (rot) {
      const cR = Math.cos(rot), sR = Math.sin(rot), ve = vel.e, vn = vel.n;
      vel.e = ve * cR + vn * sR;
      vel.n = vn * cR - ve * sR;
    }
  }

  function speedBrake() {
    if (!gridBuilt) return 1;
    const sp = Math.hypot(vel.e, vel.n);
    if (sp < 1) return 1;
    for (const [t, cap] of BRAKE_PROBES) {
      const lng = eye.lng + (vel.e * t) / mLon(eye.lat);
      const lat = eye.lat + (vel.n * t) / M_LAT;
      if (blocks(maxHeightIn(lng, lat, rCam()), alt)) return cap;
    }
    return 1;
  }

  // ── Joystick ──────────────────────────────────────────────────────
  const joystickBase = document.getElementById('joystick-base');
  const joystickKnob = document.getElementById('joystick-knob');
  let joyPointerId = null, joyFwd = 0, joyStrafe = 0, joyOx = 0, joyOy = 0;
  const joyActive = () => joyPointerId !== null;

  // ── Boost, for a device with no Shift key ─────────────────────────
  //
  // Reported: "there should be an option to sprint on mobile". Desktop reads
  // `sprintHeld` off every key event's `shiftKey`, which a phone can never
  // produce, so the 2.5x speed multiplier was simply unreachable on touch.
  //
  // IT LATCHES RATHER THAN BEING HELD, and that is the whole design decision:
  // one thumb is on the stick and the other is looking, so a hold-to-sprint
  // button would need a third. Tap on, tap off, and it lights up while it is
  // on so it can never be a mystery why the city is moving fast. It is a
  // SEPARATE flag from `sprintHeld` because every keydown and keyup overwrites
  // that one from the event — a latch stored there would be wiped by the next
  // key the user pressed.
  //
  // Built from JS, not markup, for the same reason the graphics menu is: two
  // hand-maintained copies of the same DOM (index.html and _harness.html) have
  // drifted before and cost a debugging session.
  let boostOn = false;
  const boostBtn = document.createElement('button');
  boostBtn.id = 'joy-boost';
  boostBtn.type = 'button';
  boostBtn.setAttribute('aria-label', 'Boost speed');
  boostBtn.setAttribute('aria-pressed', 'false');
  boostBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5 13l7-7 7 7"/><path d="M5 19l7-7 7 7"/></svg><b>BOOST</b>';
  const zone = document.getElementById('joystick-zone');
  if (zone) zone.appendChild(boostBtn);

  function setBoost(on) {
    boostOn = !!on;
    boostBtn.classList.toggle('on', boostOn);
    boostBtn.setAttribute('aria-pressed', boostOn ? 'true' : 'false');
  }
  // pointerdown, not click: a click on touch waits out the ~300 ms tap
  // resolution, and a speed control that answers a third of a second late feels
  // broken. preventDefault stops the synthetic mouse events and the double-tap
  // zoom that would otherwise follow.
  boostBtn.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    setBoost(!boostOn);
    markFlying();
  });
  boostBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });

  function joySet(nx, ny) {
    const r = Math.hypot(nx, ny);
    if (r <= JOY_DEAD) { joyFwd = 0; joyStrafe = 0; return; }
    const c = Math.pow((r - JOY_DEAD) / (1 - JOY_DEAD), JOY_EXPO) / r;
    joyStrafe = nx * c; joyFwd = ny * c;
  }

  // ── Canvas pointers ───────────────────────────────────────────────
  // NEVER read TouchEvent.touches — it is document-wide, and that is the whole
  // reason the old build treated the joystick thumb as a pinch finger: with a
  // thumb on the stick, every look swipe was reinterpreted as a two-finger
  // zoom, so moving and looking at the same time was impossible. Here the
  // joystick captures its own pointer and the canvas tracks only its own, so
  // the two gestures cannot collide.
  const canvas = map.getCanvas();
  const canvasPointers = new Map();     // id -> {x, y}
  let lookPointerId = null;
  let pinchDist = null, pinchCx = 0, pinchCy = 0;
  let lastTapAt = 0, lastTapX = 0, lastTapY = 0;
  let tapDragId = null, tapDragY = 0;
  const TAP_MS = 280, TAP_PX = 24;

  const isTouchPointer = e => e.pointerType === 'touch' || e.pointerType === 'pen';

  function pointerCount() { return canvasPointers.size; }

  function rebasePinch() {
    const pts = [...canvasPointers.values()];
    if (pts.length >= 2) {
      pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchCx = (pts[0].x + pts[1].x) / 2; pinchCy = (pts[0].y + pts[1].y) / 2;
    } else {
      pinchDist = null;
    }
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); } catch (err) {}
    canvasPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    syncInputActive();
    e.preventDefault();

    if (pointerCount() >= 2) { lookPointerId = null; tapDragId = null; rebasePinch(); return; }

    // Double-tap-and-drag = altitude. Gated behind a completed double tap so a
    // plain look swipe can never trigger it. This is the one-thumb altitude
    // control: with a thumb on the stick there is no hand free for a pinch.
    const now = performance.now();
    if (isTouchPointer(e) && now - lastTapAt < TAP_MS &&
        Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < TAP_PX) {
      tapDragId = e.pointerId; tapDragY = e.clientY; lookPointerId = null;
    } else {
      lookPointerId = e.pointerId;
    }
    lastTapAt = now; lastTapX = e.clientX; lastTapY = e.clientY;
    canvas.style.cursor = 'grabbing';
    markFlying();
  }

  function onPointerMove(e) {
    const p = canvasPointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (pointerCount() >= 2) {
      const pts = [...canvasPointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const cxNow = (pts[0].x + pts[1].x) / 2, cyNow = (pts[0].y + pts[1].y) / 2;
      if (pinchDist != null && d > 0) {
        touchLogAcc += Math.log(pinchDist / d);          // spread = descend
        touchLogAcc += -(cyNow - pinchCy) * PAN2_GAIN;   // two-finger drag up = climb
      }
      pinchDist = d; pinchCx = cxNow; pinchCy = cyNow;
      markFlying();
      return;
    }

    if (e.pointerId === tapDragId) {
      touchLogAcc += -dy * TAPDRAG_GAIN;
      markFlying();
      return;
    }

    if (e.pointerId !== lookPointerId) return;
    // Accumulate DEGREES, not pixels, so touch and mouse can carry different
    // sensitivities without the tick needing to know which device sent them.
    const touch = isTouchPointer(e);
    const mx = (!touch && e.movementX != null) ? e.movementX : dx;
    const my = (!touch && e.movementY != null) ? e.movementY : dy;
    if (Math.abs(mx) >= LOOK_DEADZONE) pendingYaw += mx * (touch ? SENS_YAW_TOUCH : SENS_YAW_MOUSE);
    if (Math.abs(my) >= LOOK_DEADZONE) pendingPitch += my * pitchSens(touch);
    markFlying();
  }

  function releasePointer(e) {
    canvasPointers.delete(e.pointerId);
    syncInputActive();
    try { canvas.releasePointerCapture && canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    if (e.pointerId === tapDragId) tapDragId = null;
    if (e.pointerId === lookPointerId) lookPointerId = null;
    if (pointerCount() === 1) {
      // Promote the surviving finger to look instead of letting it go inert.
      const id = [...canvasPointers.keys()][0];
      lookPointerId = id; tapDragId = null; pinchDist = null;
    } else if (pointerCount() >= 2) {
      rebasePinch();
    } else {
      pinchDist = null; lookPointerId = null; tapDragId = null;
      canvas.style.cursor = 'crosshair';
    }
  }

  // ── Wheel = altitude ──────────────────────────────────────────────
  // The most common first instinct on a 3D map. scrollZoom is disabled, so
  // before this the wheel did nothing at all.
  function onWheel(e) {
    e.preventDefault();
    let px = e.deltaMode === 1 ? e.deltaY * 16
           : e.deltaMode === 2 ? e.deltaY * window.innerHeight
           : e.deltaY;
    px = clamp(px, -240, 240);
    wheelLogAcc += -px * WHEEL_GAIN;
    markFlying();
  }

  // ── Keyboard ──────────────────────────────────────────────────────
  // Indexed by e.code, not e.key: on macOS, Option+W reports '∑' on keydown and
  // 'w' on keyup, so a key-indexed map latches forever. e.code is 'KeyW' both
  // times. The same guard runs on keyup as on keydown — mirroring it is what
  // stops a key pressed on the canvas and released over a widget from sticking.
  const MOVE_CODES = ['KeyW','KeyS','KeyA','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
                      'KeyQ','KeyE','PageUp','PageDown'];

  /**
   * THE FOCUS GUARD, AND THE BUG IT CAUSED FOR MONTHS ON WINDOWS ONLY.
   *
   * This used to be one regex — INPUT|SELECT|TEXTAREA|BUTTON — and every key
   * was swallowed for any of them. index.html contains exactly three form
   * controls: a checkbox, the time-of-day range slider, and the play button.
   * NONE of them is a text field, and not one of them does anything with W.
   *
   * So: click the daylight slider, and WASD is dead until you click the canvas
   * again. Click the play button, same. That is the whole of "when i change
   * daylight i can't move anymore", and of "sometimes even when i dont".
   *
   * IT LOOKED LIKE A HARDWARE BUG BECAUSE OF A PLATFORM DEFAULT. macOS does not
   * give keyboard focus to a button or a slider when you click it (Full Keyboard
   * Access is off by default); Windows always does. Same code, same build, dead
   * on one machine and fine on the other — which is exactly the shape that sent
   * the first look at this hunting a GPU driver.
   *
   * WHAT THE GUARD IS ACTUALLY FOR. Two different things, so two predicates:
   *
   *   textTarget   real text entry. Every keystroke belongs to the field, and
   *                the camera must not move while someone types. Nothing in the
   *                app matches this today; it is here so adding a search box
   *                later does not reintroduce the flying-while-typing bug.
   *
   *   stepTarget   a widget the ARROW and PAGE keys drive natively — a range
   *                slider steps with them, a select changes option. Those keys
   *                are the widget's; the letters are not, so W/A/S/D/Q/E fly the
   *                camera even while the slider has focus. That is the fix.
   *
   * A BUTTON or a CHECKBOX appears in neither: Space and Enter are theirs and
   * neither is a movement key, so there is nothing to guard.
   */
  const TEXT_INPUT_TYPES = /^(|text|search|url|tel|email|password|number|date|time|datetime-local|month|week)$/;
  const STEP_CODES = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End'];

  function textTarget(t) {
    if (!t) return false;
    if (t.isContentEditable) return true;
    if (t.tagName === 'TEXTAREA') return true;
    // A `select` type-aheads on letter keys, so it owns those too.
    if (t.tagName === 'SELECT') return true;
    if (t.tagName !== 'INPUT') return false;
    return TEXT_INPUT_TYPES.test((t.type || '').toLowerCase());
  }
  function stepTarget(t) {
    if (!t) return false;
    if (t.tagName === 'SELECT') return true;
    return t.tagName === 'INPUT' && (t.type || '').toLowerCase() === 'range';
  }

  function onKeyDown(e) {
    sprintHeld = e.shiftKey;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (textTarget(e.target)) return;                 // typing beats flying
    if (stepTarget(e.target) && STEP_CODES.indexOf(e.code) !== -1) return;  // the slider's own keys
    if (e.code === 'KeyR') { goHome(); e.preventDefault(); return; }
    if (MOVE_CODES.indexOf(e.code) === -1) return;
    keys[e.code] = true;
    e.preventDefault();
    markFlying();
  }

  /**
   * KEYUP RELEASES UNCONDITIONALLY, whatever has focus.
   *
   * The old version mirrored the keydown guard here, which is the wrong
   * symmetry: releasing a key you were not holding is a no-op, but FAILING to
   * release one you were holding latches it down and the camera flies off by
   * itself until something calls clearInputs(). Press W over the canvas, click
   * the slider mid-hold, let go — that was a permanent stuck key. Always
   * release.
   */
  function onKeyUp(e) {
    sprintHeld = e.shiftKey;
    keys[e.code] = false;
  }

  function goHome() {
    if (!HOME) return;
    clearInputs();
    wasDriving = false;
    map.easeTo({ center: HOME.center, zoom: HOME.zoom, bearing: HOME.bearing, pitch: HOME.pitch,
                 duration: 900 }, { fly: true });
  }

  // ── Input reset ───────────────────────────────────────────────────
  // Without this, alt-tabbing while holding W never delivers the keyup and the
  // camera flies on forever; Ctrl+Shift+I strands Shift at a 2.5x boost.
  function clearInputs() {
    for (const k in keys) keys[k] = false;
    sprintHeld = false;
    setBoost(false);                 // a latch must not survive an alt-tab
    joyFwd = 0; joyStrafe = 0; joyPointerId = null;
    if (joystickKnob) joystickKnob.style.transform = '';
    canvasPointers.clear();
    lookPointerId = null; tapDragId = null; pinchDist = null;
    pendingYaw = pendingPitch = wheelLogAcc = touchLogAcc = 0;
    vel.e = 0; vel.n = 0;
    lastTs = null;
    // Hand the camera back level and at base FOV: goHome()'s easeTo (and any
    // other external animation that follows a clearInputs) must start neutral.
    resetEffectsHard();
    syncInputActive();
    canvas.style.cursor = 'crosshair';
  }
  const onBlur = () => clearInputs();
  const onVisibility = () => { if (document.hidden) clearInputs(); };

  // ── Chrome fade ───────────────────────────────────────────────────
  //
  // `.flying` has a deliberate 4-second idle tail so the hint always comes back,
  // and style.css used to hang `pointer-events:none` on the side panels off it.
  // That made the time-of-day slider dead for four seconds after every burst of
  // flying, with nothing to do but wait — the exact thing it felt like. The
  // protection is only needed while a finger is actually down (a right-thumb
  // look swipe must not drag the slider), so it now rides `.input-active`, which
  // is on for precisely the duration of the gesture.
  function syncInputActive() {
    const on = canvasPointers.size > 0 || joyPointerId !== null;
    document.body.classList.toggle('input-active', on);
  }

  let flyingSince = 0, flyingTimer = null;
  function markFlying() {
    flyingSince = flyingSince || performance.now();
    if (performance.now() - flyingSince > 200) document.body.classList.add('flying');
    clearTimeout(flyingTimer);
    flyingTimer = setTimeout(() => {
      document.body.classList.remove('flying');
      flyingSince = 0;
    }, 4000);
  }

  // ── Tick ──────────────────────────────────────────────────────────
  let tickMsAcc = 0, tickCount = 0;

  function tick(ts) {
    rafId = requestAnimationFrame(tick);
    if (lastTs === null) { lastTs = ts; return; }
    const dtRaw = (ts - lastTs) / 1000;
    lastTs = ts;
    if (dtRaw > DT_BAIL) return;                  // tab restore: never integrate a huge step
    const dt = Math.min(dtRaw, DT_MAX);
    const t0 = performance.now();
    simTime += dt;
    // Outside the `driving` gate on purpose: the intro cinematic and the R
    // reset both move the camera without this controller owning it, and the
    // collision field wants filling in during exactly those, not after.
    outerMaybeScan();
    trunkMaybeScan();

    const sprint = (sprintHeld || boostOn) ? SPRINT : 1;
    let fwd = 0, strafe = 0;
    if (keyDown('KeyW') || keyDown('ArrowUp'))    fwd += 1;
    if (keyDown('KeyS') || keyDown('ArrowDown'))  fwd -= 1;
    if (keyDown('KeyD') || keyDown('ArrowRight')) strafe += 1;
    if (keyDown('KeyA') || keyDown('ArrowLeft'))  strafe -= 1;
    fwd += joyFwd; strafe += joyStrafe;

    const vertKey = (keyDown('KeyQ') || keyDown('PageUp') ? 1 : 0) -
                    (keyDown('KeyE') || keyDown('PageDown') ? 1 : 0);

    // ── Arbitration. While nobody is flying we write NOTHING and simply read
    // the map, so the cinematic intro, the R reset and diff-tour's flyTo all
    // run to completion instead of being aborted by a per-frame jumpTo.
    //
    // The altitude test compares against the RESOLVED target, not against
    // altUser. Testing `altFloor > 0` instead would pin `driving` true forever
    // any time the camera rests over a rooftop — the floor is a standing
    // response, not an intent — and the controller would then own the camera
    // permanently and stomp on every external animation.
    const inputActive = fwd !== 0 || strafe !== 0 || vertKey !== 0 ||
                        lookPointerId !== null || tapDragId !== null || pointerCount() >= 2 ||
                        pendingYaw !== 0 || pendingPitch !== 0 ||
                        wheelLogAcc !== 0 || touchLogAcc !== 0;
    const resolvedAlt = clamp(Math.max(altUser, altFloor), altFloorMin(), altCeiling());
    // realDrive is the original driving test. fxLive extends ownership only
    // while a feel effect (bank return, FOV relax, bob, settle) still has a
    // non-negligible output offset to write; every effect decays to exactly
    // zero in bounded time after the last real input, so ownership always
    // releases. See the yield rule below for what happens if something
    // external starts animating during that tail.
    const realDrive = inputActive ||
                      Math.hypot(vel.e, vel.n) > V_EPS ||
                      Math.abs(alt - resolvedAlt) > 0.05;
    const driving = realDrive || fxLive;

    if (!driving) {
      if (wasDriving) resetEffectsHard();          // hand back level, at base FOV
      else if (ROLL_OK && map.getRoll() !== 0 && !(map.isEasing && map.isEasing())) {
        map.setRoll(0);                            // self-heal: nothing else in this app sets roll
      }
      wasDriving = false; syncFromMap(); return;
    }
    if (!wasDriving) {
      if (map.isEasing && map.isEasing()) map.stop();
      syncFromMap();
      wasDriving = true;
    } else if (!realDrive && map.isEasing && map.isEasing()) {
      // Yield rule: only decaying effects were holding ownership and something
      // external (goHome's easeTo, diff-tour's flyTo) has started animating.
      // Snap the effects to neutral and release before writing anything, so the
      // external animation runs to completion untouched.
      resetEffectsHard();
      wasDriving = false;
      return;
    }
    if (inputActive) lastRealInputT = simTime;

    // ── Look
    let appliedYaw = 0;                            // signed Δbearing this frame, deg
    if (pendingYaw)   { appliedYaw = -pendingYaw; bearing = wrap360(bearing - pendingYaw); pendingYaw = 0; }
    if (pendingPitch) { pitch = clamp(pitch + pendingPitch, pitchFloor(), Math.max(pitchFloor(), pitchCap()));
                        lastPitchInputT = simTime; pendingPitch = 0; }

    // ── Altitude intent (multiplicative: one key-second is always the same
    // proportional change, so it feels identical at 20 m and at 800 m)
    let L = vertKey * VERT_GAIN * dt * sprint;
    L += wheelLogAcc; wheelLogAcc = 0;
    L += touchLogAcc; touchLogAcc = 0;
    const vertActive = L !== 0;                    // any vertical intent this frame (keys, wheel, touch)
    if (L) altUser *= Math.exp(L);
    // Don't let the user bank a low altitude while riding a rooftop and then
    // drop down a shaft the moment the roof ends.
    altUser = Math.max(altUser, alt - ALT_SLACK);
    // Only the ABSOLUTE limits touch the user's intent. altCeiling() varies with
    // pitch, so clamping intent against it would let one big pitch step (a fast
    // drag, or a slow frame that coalesces a whole gesture) permanently eat the
    // altitude you had asked for, and pitching back would not give it back.
    // The pitch-dependent ceiling is applied to the RENDERED altitude instead.
    //
    // The FLOOR, unlike the ceiling, does have to be pitch-dependent, and for the
    // opposite reason: below dMin*cos(pitch) the pose is not expressible at all
    // (see pitchFloorAt) and the render would silently pull the eye back instead
    // of reporting a failure. Blocking the descent is the honest half of the same
    // pair as blocking the pitch — together they mean the state can never enter a
    // pose the renderer cannot draw. At pitch 88 this floor is 0.64 m, so ALT_MIN
    // binds and walking height is fully reachable; it only bites if you try to
    // descend to the pavement while looking down at it.
    altUser = clamp(altUser, altFloorMin(), ALT_MAX);

    // ── Horizontal intent. CLAMP the magnitude rather than normalise, so a
    // half-deflected joystick still means half speed while W+D no longer
    // means 1.41x speed.
    const m = Math.hypot(fwd, strafe);
    if (m > 1) { fwd /= m; strafe /= m; }
    const spdBase = clamp(SPEED_REF * Math.pow(alt / ALT_REF, SPEED_EXP), SPEED_MIN, SPEED_MAX);
    const spd = spdBase * sprint;
    const strafeIn = strafe;                       // normalised strafe input, for the bank lean
    const brake = speedBrake();
    const b = rad(bearing);
    const tE = (fwd * Math.sin(b) + strafe * Math.cos(b)) * spd * brake;
    const tN = (fwd * Math.cos(b) - strafe * Math.sin(b)) * spd * brake;
    const tau = Math.hypot(tE, tN) >= Math.hypot(vel.e, vel.n) ? TAU_ACCEL : TAU_DECEL;
    const k = 1 - Math.exp(-dt / tau);
    vel.e += (tE - vel.e) * k;
    vel.n += (tN - vel.n) * k;
    if (!fwd && !strafe && Math.hypot(vel.e, vel.n) < V_EPS) { vel.e = 0; vel.n = 0; }

    // ── Fence: ease to a stop near the edge of the data rather than letting
    // the user drift into empty basemap.
    if (fence) {
      const mx = mLon(eye.lat);
      const dW = (eye.lng - fence.w) * mx, dE = (fence.e - eye.lng) * mx;
      const dS = (eye.lat - fence.s) * M_LAT, dN = (fence.n - eye.lat) * M_LAT;
      if (vel.e < 0 && dW < FENCE_SOFT) vel.e *= clamp(dW / FENCE_SOFT, 0, 1);
      if (vel.e > 0 && dE < FENCE_SOFT) vel.e *= clamp(dE / FENCE_SOFT, 0, 1);
      if (vel.n < 0 && dS < FENCE_SOFT) vel.n *= clamp(dS / FENCE_SOFT, 0, 1);
      if (vel.n > 0 && dN < FENCE_SOFT) vel.n *= clamp(dN / FENCE_SOFT, 0, 1);
    }

    // ── Advance and collide. Metres in, degrees out — that single conversion
    // is the entire cos(latitude) fix.
    //
    // Substepped so no single frame can step further than the probe radius: at
    // SPEED_MAX with a 0.1 s frame the displacement is 12 m, twice R_CAM, which
    // would let the camera tunnel clean through a narrow building between two
    // samples.
    const frameDist = Math.hypot(vel.e, vel.n) * dt;
    const steps = Math.max(1, Math.ceil(frameDist / (R_CAM * 0.75)));
    const sdt = dt / steps;
    let stepFloor = 0;
    // Read ONCE per frame, before the walk, and held for every substep: if the
    // camera starts the frame inside a trunk it must be able to leave, and a
    // test re-evaluated mid-walk could flip to "stuck" the instant the first
    // substep put it in.
    trunkStuck = trunkAt(eye.lng, eye.lat);

    for (let s = 0; s < steps; s++) {
      const pLng = eye.lng + (vel.e * sdt) / mLon(eye.lat);
      const pLat = eye.lat + (vel.n * sdt) / M_LAT;
      // A trunk is a WALL, never a kerb, so it is kept out of the step-up test
      // below rather than folded into blockedAt. Fold it in and a 4.95 m oak
      // becomes something the camera climbs.
      const tBlk = trunkBlockedAt(pLng, pLat);

      // Block and slide. Exactly ONE axis is applied when blocked: applying
      // both independently-free axes would reconstruct the very diagonal that
      // was just rejected and stutter along 45-degree walls.
      if (!tBlk && (!gridBuilt || !blockedAt(pLng, pLat))) {
        eye.lng = pLng; eye.lat = pLat;
      } else {
        const hObs = gridBuilt ? maxHeightIn(pLng, pLat, rCam()) : 0;
        if (!tBlk && hObs + SKIN - alt <= stepUp()) {   // low enough to skim over
          stepFloor = Math.max(stepFloor, hObs + skinV());
          eye.lng = pLng; eye.lat = pLat;
        } else if (!hardBlockedAt(pLng, eye.lat)) {
          // Slide east-west; the blocked northward component deflects (damped
          // + steered by wallDeflect) instead of zeroing instantly. Exactly one
          // axis of POSITION is still applied, as before.
          eye.lng = pLng; wallDeflect(sdt, false, true);
        } else if (!hardBlockedAt(eye.lng, pLat)) {
          eye.lat = pLat; wallDeflect(sdt, true, false);
        } else {
          wallDeflect(sdt, true, true);
        }
      }
    }
    if (fence) {
      eye.lng = clamp(eye.lng, fence.w, fence.e);
      eye.lat = clamp(eye.lat, fence.s, fence.n);
    }

    // ── Rooftop floor
    if (gridBuilt) {
      const aLng = eye.lng + (vel.e * FLOOR_LOOKAHEAD) / mLon(eye.lat);
      const aLat = eye.lat + (vel.n * FLOOR_LOOKAHEAD) / M_LAT;
      const roof = Math.max(maxHeightIn(eye.lng, eye.lat, rCam()), maxHeightIn(aLng, aLat, rCam()));
      let want = roof > 0 ? roof + skinV() : 0;
      if (want - altUser > stepUp()) want = 0;    // too tall to lift over; the slide already stopped us
      want = Math.max(want, stepFloor);
      const tf = want > altFloor ? TAU_FLOOR_UP : TAU_FLOOR_DOWN;
      const next = altFloor + (want - altFloor) * (1 - Math.exp(-dt / tf));
      altFloor += clamp(next - altFloor, -FALL * dt, LIFT * dt);
    } else {
      altFloor = SAFE_ALT;                          // fail safe, never fail open
    }

    alt = clamp(Math.max(altUser, altFloor), altFloorMin(), altCeiling());

    // ── Hard net: the guarantee rather than the feel. Fires essentially never.
    if (gridBuilt) {
      const h = maxHeightIn(eye.lng, eye.lat, rCam());
      if (h > 0 && alt < h + HARD_CLEAR) { alt = altUser = h + HARD_CLEAR; }
    }

    // ── Feel effects (TUNE block). All pure output offsets; each one decays
    // to exactly zero in bounded time after the last real input, which is what
    // lets `driving` release and external animations run. ─────────────
    {
      const sp = Math.hypot(vel.e, vel.n);

      // Bank roll: smoothed yaw rate plus a small strafe lean, clamped.
      // Sign convention measured on the vendored MapLibre: roll > 0 renders as
      // a right bank (horizon right end up), and bearing increasing = turning
      // right, so bank = +k * yawRate banks INTO the turn.
      const instYaw = clamp(appliedYaw / dt, -TUNE.YAW_RATE_CLAMP, TUNE.YAW_RATE_CLAMP);
      yawRate += (instYaw - yawRate) * (1 - Math.exp(-dt / TUNE.TAU_YAW_RATE));
      let bankT = 0;
      if (ROLL_OK) {
        bankT = clamp(yawRate * TUNE.BANK_PER_DEGPS + strafeIn * TUNE.BANK_STRAFE,
                      -TUNE.BANK_MAX, TUNE.BANK_MAX);
        const tb = Math.abs(bankT) > Math.abs(rollNow) ? TUNE.TAU_BANK_IN : TUNE.TAU_BANK_OUT;
        rollNow += (bankT - rollNow) * (1 - Math.exp(-dt / tb));
        if (Math.abs(bankT) < 1e-3 && Math.abs(rollNow) < TUNE.ROLL_EPS) rollNow = 0;
      }

      // FOV kick: how far ABOVE cruise speed the camera actually is, so it
      // responds to what the camera is DOING, not to key state, and so the
      // whole effect belongs to sprinting rather than being half-spent by
      // ordinary flight (see TUNE.FOV_KICK). Kicks relative to the graphics
      // menu's live base FOV and snaps back exactly to it.
      if (FOV_OK) {
        const over = (sp / Math.max(1e-3, spdBase) - TUNE.FOV_KICK_FROM) /
                     Math.max(1e-3, SPRINT - TUNE.FOV_KICK_FROM);
        const fovT = TUNE.FOV_KICK * clamp(over, 0, 1);
        fovKickNow += (fovT - fovKickNow) * (1 - Math.exp(-dt / TUNE.TAU_FOV));
        if (fovT < TUNE.FOV_EPS && fovKickNow < TUNE.FOV_EPS) fovKickNow = 0;
        const want = baseFov() + fovKickNow;
        // Written BEFORE writeToMap so the derived zoom compensates in the same
        // frame (camPx() reads the live FOV) and the world scale stays anchored.
        if (Math.abs(map.getVerticalFieldOfView() - want) > 0.005) {
          map.setVerticalFieldOfView(want);
        }
      }

      // Landing settle: a one-shot eased dip when arriving at a stop from speed.
      if (prevSpeed >= TUNE.SETTLE_TRIG_SPEED && sp < TUNE.SETTLE_TRIG_SPEED &&
          peakSpeed >= TUNE.SETTLE_MIN_SPEED && settleT >= TUNE.SETTLE_DUR) {
        settleT = 0; peakSpeed = 0;
      }
      peakSpeed = Math.max(peakSpeed, sp);
      prevSpeed = sp;
      let settleOff = 0;
      if (settleT < TUNE.SETTLE_DUR) {
        settleOff = -lerp(TUNE.SETTLE_AMP, TUNE.SETTLE_AMP_GROUND, groundMix()) *
                    Math.sin(PI * (settleT / TUNE.SETTLE_DUR));
        settleT += dt;
      }

      // Hover bob: a slow upward breathing while actively hovering. Winds down
      // to zero within BOB_TIMEOUT of the last real input so ownership releases.
      const tSince = simTime - lastRealInputT;
      const bobT = (tSince < TUNE.BOB_TIMEOUT && sp < TUNE.BOB_MAX_SPEED &&
                    vertKey === 0 && !vertActive) ? 1 : 0;
      bobGain += (bobT - bobGain) * (1 - Math.exp(-dt / TUNE.TAU_BOB));
      if (bobT === 0 && bobGain < 0.01) bobGain = 0;
      const bobAmp = bobGain * clamp((TUNE.BOB_TIMEOUT - tSince) / TUNE.BOB_FADE, 0, 1);
      const ph = 2 * PI * simTime / TUNE.BOB_PERIOD;
      const bobAlt = bobAmp * lerp(TUNE.BOB_AMP_ALT, TUNE.BOB_AMP_ALT_GROUND, groundMix()) *
                     (0.5 - 0.5 * Math.cos(ph));
      const bobPitch = bobAmp * TUNE.BOB_AMP_PITCH * Math.sin(ph + 1.1);

      // Speed-adaptive pitch: ease toward the horizon at sustained speed, only
      // when the user hasn't touched pitch recently; backs out fast if they do.
      if (TUNE.PITCH_SPEED > 0) {
        const idleOk = (simTime - lastPitchInputT) > TUNE.PITCH_SPD_IDLE;
        const pT = idleOk ? TUNE.PITCH_SPEED * clamp(sp / (spdBase * SPRINT), 0, 1) : 0;
        const tp = pT > pitchSpdNow ? TUNE.TAU_PITCH_SPD : TUNE.TAU_PITCH_SPD_OUT;
        pitchSpdNow += (pT - pitchSpdNow) * (1 - Math.exp(-dt / tp));
        if (pT === 0 && pitchSpdNow < 0.02) pitchSpdNow = 0;
      }

      fxAltOff = bobAlt + settleOff;
      fxPitchOff = bobPitch + pitchSpdNow;
      fxLive = rollNow !== 0 || fovKickNow > 0 || bobAmp > 0.005 ||
               settleT < TUNE.SETTLE_DUR || pitchSpdNow > 0;
    }

    writeToMap();

    tickMsAcc += performance.now() - t0; tickCount++;
    if (window.__fly) {
      window.__fly.ticks = tickCount;
      window.__fly.tickMsAvg = tickMsAcc / tickCount;
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────
  const prevHandlers = {};
  const HANDLERS = ['dragPan','dragRotate','doubleClickZoom','keyboard','touchPitch',
                    'touchZoomRotate','boxZoom','scrollZoom'];
  for (const h of HANDLERS) {
    if (map[h] && typeof map[h].isEnabled === 'function') {
      prevHandlers[h] = map[h].isEnabled();
      map[h].disable();
    }
  }

  map.getCanvasContainer().style.touchAction = 'none';
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'crosshair';
  document.body.style.overscrollBehavior = 'none';
  document.documentElement.classList.toggle('has-touch', navigator.maxTouchPoints > 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('lostpointercapture', releasePointer);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pageshow', onBlur);
  window.addEventListener('pagehide', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  // Joystick: Pointer Events with its own capture, so its finger never reaches
  // the canvas — and so it also works with a mouse, pen or trackpad (an iPad
  // with a Magic Keyboard, or any desktop window under 1025 px wide).
  function onJoyDown(e) {
    if (joyPointerId !== null) return;
    joyPointerId = e.pointerId;
    try { joystickBase.setPointerCapture && joystickBase.setPointerCapture(e.pointerId); } catch (err) {}
    const r = joystickBase.getBoundingClientRect();
    joyOx = r.left + r.width / 2; joyOy = r.top + r.height / 2;
    syncInputActive();
    e.preventDefault(); e.stopPropagation();
    markFlying();
  }
  function onJoyMove(e) {
    if (e.pointerId !== joyPointerId) return;
    const rx = e.clientX - joyOx, ry = e.clientY - joyOy;
    const dist = Math.hypot(rx, ry), capped = Math.min(dist, JOY_RADIUS);
    const ang = Math.atan2(ry, rx);
    const kx = Math.cos(ang) * capped, ky = Math.sin(ang) * capped;
    if (joystickKnob) joystickKnob.style.transform = `translate(${kx}px, ${ky}px)`;
    joySet(kx / JOY_RADIUS, -ky / JOY_RADIUS);
    e.preventDefault(); e.stopPropagation();
    markFlying();
  }
  function onJoyUp(e) {
    if (e.pointerId !== joyPointerId) return;
    joyPointerId = null; joyFwd = 0; joyStrafe = 0;
    syncInputActive();
    if (joystickKnob) joystickKnob.style.transform = '';
    try { joystickBase.releasePointerCapture && joystickBase.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  if (joystickBase) {
    joystickBase.style.touchAction = 'none';
    joystickBase.addEventListener('pointerdown', onJoyDown);
    joystickBase.addEventListener('pointermove', onJoyMove);
    joystickBase.addEventListener('pointerup', onJoyUp);
    joystickBase.addEventListener('pointercancel', onJoyUp);
    joystickBase.addEventListener('lostpointercapture', onJoyUp);
  }

  // ── Init ──────────────────────────────────────────────────────────
  syncFromMap();
  ALT_REF = alt || 230;
  HOME = { center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom(),
           bearing: map.getBearing(), pitch: map.getPitch() };
  buildHeightField(scene);

  window.__flyRebuildCollision = sc => { buildHeightField(sc); };
  window.__fly = {
    eye: () => ({ lng: eye.lng, lat: eye.lat, alt, altUser, altFloor,
                  vE: vel.e, vN: vel.n, bearing, pitch, driving: wasDriving }),
    roofAt: (lng, lat, r) => maxHeightIn(lng, lat, r == null ? R_CAM : r),
    indexed: () => gridBuilt,
    gridBytes: () => (grid ? grid.byteLength : 0),
    // The fence, in degrees, and how much of the outer ring the incremental
    // collision field has seen. Both exist so a verification can assert on them
    // instead of inferring them from where the camera stopped.
    fence: () => (fence ? { w: fence.w, s: fence.s, e: fence.e, n: fence.n } : null),
    outerField: () => ({ cells: outerCells.size, features: outerFeatures,
                         scans: outerScans,
                         avgMs: outerScans ? +(outerScanMs / outerScans).toFixed(2) : 0,
                         maxMs: +outerScanMsMax.toFixed(2) }),
    outerScan: () => { outerScanAt = 0; outerStamp(); return outerCells.size; },
    // The trunk field, on the same terms as the outer one: a verification can
    // assert on what it holds and what it cost instead of inferring both from
    // where the camera stopped.
    trunkField: () => ({ buckets: trunkBuckets.size, trunks: trunkCount,
                         scans: trunkScans,
                         avgMs: trunkScans ? +(trunkScanMs / trunkScans).toFixed(2) : 0,
                         maxMs: +trunkScanMsMax.toFixed(2),
                         density: treeDensity(), dirty: trunkDirty,
                         stuck: trunkStuck }),
    trunkScan: () => { trunkScanAt = 0; trunkStamp(); return trunkCount; },
    trunkAt: (lng, lat, a) => trunkAt(lng, lat, a),
    // A FUNCTION, not a snapshot. It used to be an object literal evaluated once
    // at init, so anything derived (the live probe radius, the pitch floor, the
    // altitude floor as pitch changes it) could not be read by a verification at
    // all, and a runtime override would have been invisible. pitch-probe.mjs
    // already calls it either way.
    consts: () => ({ ALT_REF, ALT_MIN, ALT_MAX, ALT_GROUND, ALT_RENDER_MIN,
                     ZOOM_MIN, ZOOM_MAX, R_CAM, R_CAM_GROUND, HARD_CLEAR,
                     SKIN, SKIN_V, SKIN_V_GROUND, STEP_UP, STEP_UP_GROUND,
                     OUTER_MIN_H, OUTER_MIN_H_GROUND, PITCH_MIN, PITCH_MAX,
                     TRUNK_ON, TRUNK_PAD, TRUNK_CLEAR, TRUNK_ALT, TRUNK_BUCKET,
                     TRUNK_R_MIN, TRUNK_R_MAX,
                     SPEED_REF, SPEED_EXP, SPEED_MIN, SPEED_MAX,
                     TAU_ACCEL, TAU_DECEL, VERT_GAIN, SPRINT,
                     // live, derived — the whole point of making this a function
                     groundMix: groundMix(), rCam: rCam(), skinV: skinV(),
                     stepUp: stepUp(), dMin: dMin(), pitchFloor: pitchFloor(),
                     altFloorMin: altFloorMin(), outerMinH: outerMinH(),
                     lookPitchSpanPx: LOOK.PITCH_SPAN_PX,
                     pitchSensTouch: pitchSens(true), pitchSensMouse: pitchSens(false) }),
    simTime: () => simTime,
    // Feel-effect debug/override surface: `tune` is the live TUNE object (any
    // value can be overruled at runtime), `fx` is this frame's derived outputs.
    tune: TUNE,
    // Live look tuning. `look.PITCH_SPAN_PX = 1` restores the stock, unfitted
    // vertical sensitivity, which is how the A/B for this is run in one session.
    look: LOOK,
    fx: () => ({ roll: rollNow, fovKick: fovKickNow, altOff: fxAltOff,
                 pitchOff: fxPitchOff, yawRate, live: fxLive,
                 rollOk: ROLL_OK, fovOk: FOV_OK, boost: boostOn }),
    // The touch boost latch, so a test can drive it without synthesising a
    // pointer sequence against a button that only exists on narrow layouts.
    setBoost: on => setBoost(on),
    ticks: 0, tickMsAvg: 0,
  };

  rafId = requestAnimationFrame(tick);

  return function cleanup() {
    cancelAnimationFrame(rafId);
    clearTimeout(flyingTimer);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', releasePointer);
    canvas.removeEventListener('pointercancel', releasePointer);
    canvas.removeEventListener('lostpointercapture', releasePointer);
    canvas.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pageshow', onBlur);
    window.removeEventListener('pagehide', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
    if (trunkListening) { try { map.off("sourcedata", onTrunkSourceData); } catch (e) {} }
    if (joystickBase) {
      joystickBase.removeEventListener('pointerdown', onJoyDown);
      joystickBase.removeEventListener('pointermove', onJoyMove);
      joystickBase.removeEventListener('pointerup', onJoyUp);
      joystickBase.removeEventListener('pointercancel', onJoyUp);
      joystickBase.removeEventListener('lostpointercapture', onJoyUp);
    }
    if (boostBtn && boostBtn.parentNode) boostBtn.parentNode.removeChild(boostBtn);
    for (const h of HANDLERS) {
      if (prevHandlers[h] && map[h] && typeof map[h].enable === 'function') map[h].enable();
    }
    delete window.__fly; delete window.__flyRebuildCollision;
  };
}
