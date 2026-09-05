/**
 * sky.js — the sun, and everything in the sky above Austin
 *
 * Two jobs.
 *
 * 1. ONE SUN. Before this file there were two: shadows.js walked its own arc
 *    (az 150→245) while setLight used another (az 205→252), 55° apart at p=0.
 *    Shadows pointed one way and the shading came from somewhere else, which is
 *    the kind of incoherence you feel without being able to name. `skyBodies(p)`
 *    is now the single source of truth for shadow direction, MapLibre's light,
 *    and the visible disc.
 *
 * 2. THE SKY ITSELF. map.setSky() gives a two-stop gradient and nothing else —
 *    no sun, no clouds, no stars. Those are drawn here as DOM/canvas overlays
 *    composited with `mix-blend-mode: screen`.
 *
 *    Screen blending is the whole trick: it can only ADD light, so a 97 m tower
 *    crossing the horizon line is never hidden by the sky drawn "behind" it — it
 *    just picks up a little bloom, which is what a bright sky actually does to a
 *    silhouette. (The alternative, a custom WebGL layer, was tried: it does own
 *    the sky, but inserted at the bottom of the style it also painted over the
 *    ground plane. Verified by rendering it solid magenta — the roads went
 *    magenta too.)
 *
 * GEOMETRY NOTE, because it drove the whole design: MapLibre pitch is measured
 * from straight down, so the view axis sits at (pitch - 90)° relative to
 * horizontal and the top of the frame is at (pitch - 90 + fov/2)°. At the spawn
 * pitch of 64 with a 58° FOV that is +3° — you can see three degrees of sky.
 * A sun disc is therefore invisible at the default view no matter where it is,
 * so the horizon glow and the low cloud band are what carry the default frame;
 * the disc is what you get for pitching up, or for golden hour.
 *
 * Public (window) API:
 *   skyBodies(p)        — { sun:{az,elev}, moon:{az,elev}, sunUp, night }
 *   initSky(map)        — create the overlay elements
 *   updateSky(map, p)   — reposition/retint everything
 */
(function () {
  'use strict';

  const PI = Math.PI;
  const rad = d => d * PI / 180;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const clamp01 = v => clamp(v, 0, 1);

  // ── The sun's arc ─────────────────────────────────────────────────
  // Morning in the east → noon in the south → golden hour low in the WSW →
  // below the horizon. Shadows swing right across the city as you drag the
  // slider, which is most of why the time-of-day control feels physical.
  const SUN_KEYS = [
    { p: 0.00, az: 98,  elev: 54 },
    { p: 0.25, az: 150, elev: 64 },
    { p: 0.42, az: 232, elev: 30 },
    { p: 0.50, az: 256, elev: 6  },
    { p: 0.60, az: 268, elev: -4 },
    { p: 1.00, az: 305, elev: -40 },
  ];
  // The moon takes over once the sun is down, rising in the east. It peaks at
  // 24° rather than overhead on purpose: at a flying pitch of 64-82 the visible
  // sky runs from the horizon to only ~+21°, so a moon high in the dome is a
  // moon nobody ever sees.
  const MOON_KEYS = [
    { p: 0.55, az: 88,  elev: -6 },
    { p: 0.72, az: 98,  elev: 10 },
    { p: 1.00, az: 118, elev: 24 },
  ];

  // ── Taste constants (LIGHT beauty pass, July 30 2026) ─────────────
  // Exposed as window.SKY_TUNE so any value can be overruled live from the
  // console with a one-line edit.
  const SKY_TUNE = {
    // Clouds: each lobe's radial gradient is offset toward the lighting body
    // and falls off into a shaded base colour, so day clouds get a bright top
    // over a soft grey base and a low golden sun lights their undersides.
    CLOUD: {
      OFFSET: 0.45,           // gradient centre offset toward the light, fraction of lobe r
      BASE: [160, 170, 192],  // shaded-side colour at full day (grey-blue)
      BASE_MIX: 0.68,         // how far the far side falls toward BASE (0 = flat lobes again)
      RIM: 1.22,              // alpha gain on the lit core
    },
    // Belt of Venus: at dusk the ANTI-solar horizon carries a rosy band above
    // the rising earth-shadow. A screen blend cannot darken, so the shadow is
    // a cool blue lift under a rose one — the contrast is what reads.
    BELT: {
      P0: 0.50, P1: 0.585, P2: 0.70,           // ramp in / peak / ramp out (in p)
      ROSE: [255, 138, 150], ROSE_A: 0.22,
      BLUE: [58, 78, 138],   BLUE_A: 0.20,
      ROSE_ELEV: 4.2, BLUE_ELEV: 0.8,          // band centres, degrees above horizon
      RX: 0.62, RY_ROSE: 0.085, RY_BLUE: 0.05, // ellipse radii, fractions of max(W,H)
      STOPS: [[0, 1], [0.45, 0.5], [1, 0]],
    },
    // How far BELOW the horizon the sky's additive wash fades out, as a
    // fraction of frame height.
    //
    // THIS WAS THE SECOND LINE. The sky pass is clipped so its glow cannot
    // paint the city, and the clip used to be a hard `rect` at hzPx + 0.018*H
    // with the comment "a small margin keeps the boundary soft". A hard edge is
    // not soft: the margin put the cut 18 px INSIDE the city, so every tower
    // crossing that row got the full horizon wash on the part above it and none
    // below. MEASURED at midday on the tower at Sixth & Guadalupe, before this
    // change: luma 117.0 at row 358 and 80.4 at row 359 — a 36.6 luma step in
    // one pixel row, at exactly hzPx + 0.018*H.
    //
    // It hid behind the ground haze until that was fixed, and it is the same
    // complaint with the opposite sign: above the line the building is lighter,
    // below it is "COMPLETELY NORMAL". So the wash is now ERASED back out with a
    // gradient CENTRED ON THE HORIZON, which turns the cliff into a ramp: 36.6
    // luma over 36 rows instead of over one, about 1 luma per row, which is
    // under what an eye finds on a textured wall. Re-measured after: 2.8.
    //
    // Centred, and this width, for a reason that is not taste. The sky canvas is
    // sized to the sky band and `graphics.mjs` asserts it stays under half the
    // viewport — it was already at 48%, so there is no room to grow it
    // downward. A ramp centred on the horizon needs exactly HALF of this below
    // it, so 0.036 costs the same 0.018*H of canvas the hard clip already used
    // and the assertion is untouched. Growing it instead took the canvas to 60%
    // and turned that check red.
    HORIZON_FADE: 0.036,
    // ── THE DUSK CLOCK. One schedule, and it is the SUN'S ELEVATION ───
    //
    // THE DEFECT THIS REPLACES. The Aug 4 sweep read all 36 tour frames and
    // ranked this fourth: at the slider's midpoint (p=0.62) `dusk-capitol`,
    // `dusk-west-campus`, `dusk-the-drag` and `dusk-downtown-skyline` show a
    // saturated magenta sky WITH STARS IN IT over a city that is still lit like
    // the afternoon — not one lamp pool you can find, an entire West Campus of
    // student housing dark, the whole downtown core dark. It is the slider's
    // default neighbourhood and it may well be the first thing a visitor sees.
    //
    // The cause was that every consumer invented its own ramp in `p`, and `p`
    // is a slider position, not a time. Measured on the frames above:
    //
    //     the sky's `night`   (p-0.55)/0.35            p=0.62 -> 0.20
    //     the lamps           (p-0.58)/(0.85-0.58)     p=0.62 -> 0.148
    //     the palette         linear golden->night     p=0.62 -> 0.24
    //     the sky COLOUR      timeofday.js ROUTES      p=0.62 -> #351a47, i.e.
    //                                                  already at its night key
    //
    // The sky route front-loads its whole transition into p 0.50-0.62 and the
    // city back-loads its into p 0.62-0.75, so the two halves of the same
    // moment are about forty minutes apart and dusk is exactly where they
    // disagree. Photographed as a sequence at 0.55 / 0.62 / 0.70 / 0.80, the
    // city goes from full daylight to full night between the second and third
    // frame while the sky barely changes across the same gap.
    //
    // SO EVERYTHING BELOW IS DERIVED FROM ONE PHYSICAL NUMBER: the sun's
    // elevation, which SUN_KEYS already owns. Slider position is a control, not
    // a clock; elevation is what a photograph actually responds to, and the
    // three schedules can no longer drift apart because there is only one.
    //
    // AND THE ORDER IS DELIBERATE — artificial light LEADS the sky, because
    // that is what really happens. A streetlight's photocell trips while the
    // west is still orange; the stars are the last thing to arrive, long after
    // the lamps. Written as elevations, that ordering is legible at a glance:
    //
    //     LAMP_ON    +2   the sun's last minutes: the first lamps strike
    //     LAMP_FULL  -6   end of CIVIL twilight: the city is fully lit
    //     NIGHT_ON   +1   the sky begins to darken (sunset)
    //     STAR_ON    -7   the first stars, after the lamps are already up
    //     STAR_FULL -18   end of ASTRONOMICAL twilight: the whole field
    //     NIGHT_FULL -31  deep night
    //
    // NIGHT_ON/NIGHT_FULL are NOT a new curve. They are the old
    // `(p-0.55)/0.35` re-expressed on this clock, and the sun arc is near
    // enough linear through dusk that they reproduce it: p=0.62 gives 0.2125
    // against 0.200, p=0.70 gives 0.4375 against 0.4286, p=0.80 gives 0.719
    // against 0.714. `night` feeds graphics.js's auto-exposure target and
    // timeofday.js's label dimming, so it was deliberately NOT retuned in the
    // same pass that moved the lamps — one change at a time.
    DUSK: {
      LAMP_ON: 2, LAMP_FULL: -6,
      STAR_ON: -7, STAR_FULL: -18,
      NIGHT_ON: 1, NIGHT_FULL: -31,
    },
    // ── QUEUE Y20: the last single-body switch in the file ──────────────────
    //
    // The two HORIZON WASHES were given independent schedules long ago (see the
    // note above `useMoon` in updateSky): the sun's afterglow decays over the
    // sun's own elevation, the moon's glow rises over the moon's, both are
    // always drawn, and they cross over smoothly. That fix was only half
    // applied. `haloCol` — the COLOUR — kept the boolean, and the sun's own two
    // washes were painted in it:
    //
    //     drawGlow(hzSun, ..., glowASun, haloCol, WIDE)
    //
    // so the instant `!sunUp && moon.elev > -2` went true, the SUN's afterglow,
    // in place over the western horizon and at unchanged alpha, was repainted
    // from warm sunColour(sun.elev) to the cool moon halo in one frame. That is
    // QUEUE Y20's 83 levels of blue, measured at (0.70, 0.278) — the sky just
    // above the WESTERN horizon, which is the sun's wash and not the disc.
    //
    // The fix is to finish the two-schedule treatment: each body's wash is
    // painted in its OWN colour, always, and the only genuinely shared colour —
    // the clouds, which are lit by whatever is up — cross-fades on the weights
    // the file already computes for the washes (`wSun`, `wMoon`), both of which
    // are continuous in their own body's elevation.
    HANDOVER: {
      ON: true,               // false restores the pre-Y20 single-body switch (A/B)
      MOON_COL: [150, 172, 226],  // the moon's halo, unchanged
      MOON_CORE: [226, 234, 255], // the moon's disc core, unchanged
    },
    // Star twinkle for the bright ~quarter of the field. Driven by the clock
    // inside the existing redraw path — NO new rAF loop, so a parked camera
    // at a fixed hour costs nothing (and its stars simply hold still).
    TWINKLE: {
      MAG: 0.62,      // only stars brighter than this twinkle
      AMP: 0.35,      // peak-to-trough alpha swing, fraction of the star's alpha
      SPEED: 0.0012,  // rad/ms base angular speed
    },
  };
  window.SKY_TUNE = SKY_TUNE;

  function track(keys, p) {
    p = clamp01(p);
    if (p <= keys[0].p) return { az: keys[0].az, elev: keys[0].elev };
    for (let i = 1; i < keys.length; i++) {
      if (p <= keys[i].p) {
        const a = keys[i - 1], b = keys[i];
        const t = (p - a.p) / (b.p - a.p);
        return { az: a.az + (b.az - a.az) * t, elev: a.elev + (b.elev - a.elev) * t };
      }
    }
    const last = keys[keys.length - 1];
    return { az: last.az, elev: last.elev };
  }

  /**
   * 0 while the sun is above `hi` degrees, 1 once it is below `lo`.
   *
   * `ease` smoothsteps it. The two NEW curves take the ease because their ends
   * are moments a viewer watches for — a linear ramp starting at a corner reads
   * as "the lamps switched on just then", and the eye finds the break in SLOPE,
   * not the break in value (same lesson as the horizon feather below). `night`
   * stays linear so it reproduces the ramp it replaces exactly.
   */
  function sunRamp(elev, hi, lo, ease) {
    const u = clamp01((hi - elev) / (hi - lo));
    return ease ? u * u * (3 - 2 * u) : u;
  }

  window.skyBodies = function skyBodies(p) {
    const sun = track(SUN_KEYS, p);
    const moon = track(MOON_KEYS, p);
    const D = SKY_TUNE.DUSK;
    return {
      sun, moon,
      sunUp: sun.elev > 0,
      // 0 before dusk, 1 by full night. Drives the sky's own darkness, the
      // auto-exposure target and the label dimming.
      night: sunRamp(sun.elev, D.NIGHT_ON, D.NIGHT_FULL, false),
      // ARTIFICIAL LIGHT, and it LEADS `night` on purpose — see SKY_TUNE.DUSK.
      // js/night.js reads this for the streetlamp pools; it is the one place
      // the city's switch-on hour is authored.
      lamps: sunRamp(sun.elev, D.LAMP_ON, D.LAMP_FULL, true),
      // ...and the stars LAG it. A star at civil twilight is the loudest
      // possible "this is the middle of the night" signal and there is not one
      // in the real sky at that hour.
      stars: sunRamp(sun.elev, D.STAR_ON, D.STAR_FULL, true),
      golden: clamp01(1 - Math.abs(p - 0.5) / 0.22),
    };
  };

  // ── Celestial direction → screen pixels ───────────────────────────
  // ENU basis, z up. az is a compass bearing (0 = north, clockwise); elev is
  // degrees above the horizontal.
  function dirOf(az, elev) {
    const ce = Math.cos(rad(elev));
    return [Math.sin(rad(az)) * ce, Math.cos(rad(az)) * ce, Math.sin(rad(elev))];
  }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  function projector(map) {
    const cv = map.getCanvas();
    const W = cv.clientWidth, H = cv.clientHeight;
    const fov = map.getVerticalFieldOfView ? map.getVerticalFieldOfView() : 58;
    const bearing = map.getBearing(), pitch = map.getPitch();
    const f = dirOf(bearing, pitch - 90);                 // view axis
    const r = [Math.cos(rad(bearing)), -Math.sin(rad(bearing)), 0];
    const u = cross(r, f);
    const tv = Math.tan(rad(fov) / 2);
    const th = tv * (W / H);
    /**
     * The vector form, for the 520 stars and ~88 cloud lobes whose (az, elev)
     * NEVER CHANGE. `dirOf` is four trig calls; running it per star per frame
     * was 2,080 sin/cos on the fixed part of a field that is baked at boot.
     * The unit vectors are cached on the star/lobe records instead — see
     * `buildStars`/`buildClouds` — and this is the entry point that consumes
     * them. `project(az, elev)` below is the same function with the conversion
     * in front of it, so there is exactly one projection, not two.
     */
    function projectVec(t) {
      const fd = dot(t, f);
      // `fd` is returned so callers can FADE as a body approaches the frustum
      // edge instead of hard-cutting at it. A hard cut on the largest element on
      // screen reads as broken software.
      if (fd <= 0.02) return { front: false, x: 0, y: 0, fd, fade: 0 };
      return {
        front: true,
        x: (0.5 + 0.5 * (dot(t, r) / fd) / th) * W,
        y: (0.5 - 0.5 * (dot(t, u) / fd) / tv) * H,
        fd, fade: clamp01((fd - 0.02) / 0.23),
        W, H,
      };
    }
    function project(az, elev) { return projectVec(dirOf(az, elev)); }
    project.vec = projectVec;
    return project;
  }

  /**
   * The camera's bank, in degrees, SIGNED THE WAY THIS FILE NEEDS IT.
   *
   * MEASURED, not assumed (shots/roll/): with the controller's self-heal
   * shadowed out and roll forced to +15, the rendered horizon runs from y=540
   * on the left edge to y=205 on the right — right end UP, which is the same
   * convention controls.js records for banking into a right turn. A screen
   * rotation that lifts the right end has NDC slope +aspect*tan(roll), and the
   * world-up derivation above produces that slope for sin(-roll). Hence the
   * minus, and hence it is written down once here rather than three times.
   *
   * `getRoll` only exists on MapLibre builds that support it (controls.js gates
   * the whole bank effect on the same capability), so a build without it is
   * permanently level and this returns 0.
   */
  function cameraRollSin(map) {
    if (!map.getRoll) return 0;
    const r = map.getRoll() || 0;
    return r === 0 ? 0 : Math.sin(rad(-r));
  }

  /** Screen y of the true horizon, in CSS pixels. Same formula as atmosphere.js. */
  function horizonPx(map) {
    const H = map.getCanvas().clientHeight;
    const fov = map.getVerticalFieldOfView ? map.getVerticalFieldOfView() : 58;
    const off = Math.tan(rad(90 - map.getPitch())) / Math.tan(rad(fov) / 2);
    return (0.5 - 0.5 * off) * H;
  }

  /**
   * Halo colour as a function of solar elevation. A plain lerp on `elev/50`
   * freezes at its endpoint once the sun is below the horizon, so the afterglow
   * stopped reddening exactly when a real one starts. This keeps reddening all
   * the way down, and passes through the tuned golden value (255,133,56) at 6°
   * so the existing golden-hour look is preserved rather than re-guessed.
   */
  const SUN_COL = [
    { e: -20, c: [150, 46, 28] },
    { e: -4,  c: [214, 78, 34] },
    { e: 6,   c: [255, 133, 56] },
    { e: 20,  c: [255, 176, 110] },
    { e: 50,  c: [255, 232, 196] },
    { e: 75,  c: [255, 250, 242] },
  ];
  function sunColour(elev) {
    if (elev <= SUN_COL[0].e) return SUN_COL[0].c.slice();
    for (let i = 1; i < SUN_COL.length; i++) {
      if (elev <= SUN_COL[i].e) {
        const a = SUN_COL[i - 1], b = SUN_COL[i];
        return mix(a.c, b.c, (elev - a.e) / (b.e - a.e));
      }
    }
    return SUN_COL[SUN_COL.length - 1].c.slice();
  }

  // ── Aerial perspective: fade by DISTANCE, not by screen row ───────
  //
  // THE DEFECT THIS REPLACES, in his words, after describing it three times:
  //
  //   "ever since start theres been a horizon that shades things under it into
  //   the sky. this line follows me when i go up or down ... under the line has
  //   this nice gradient but above the line is COMPLETELY NORMAL building. so
  //   like on default sunset im looking at downtown from a medium height, the
  //   bottom half shades fine, but the top half is completely darker and the
  //   same tone."
  //
  // He was describing a screen-space gradient element, and he was right. The
  // haze used to be a full-width DIV pinned to the horizon row and faded down
  // the frame, defended by this argument: "under a pitched camera, screen row
  // and ground distance are the same variable". That is TRUE FOR THE GROUND and
  // FALSE FOR ANYTHING WITH HEIGHT. A tower's base and its crown are the same
  // distance from the camera; the base sat below the line and took most of the
  // haze, the crown sat above it and took none. MEASURED before this change, on
  // the tower at Sixth & Guadalupe from 98 m up: a **50.3 luma step across ONE
  // pixel row**, and up to 67 luma between crown and base. The old note even
  // owned the failure — "a NEAR building tall enough to reach the horizon picks
  // up haze it has not earned" — and estimated it at "a few percent". It is not
  // a few percent, and it is not only near buildings.
  //
  // THE FIX IS THE DEPTH BUFFER. Every fill-extrusion in the scene has already
  // written its true distance there. A `custom` layer with renderingMode '3d'
  // shares that buffer (probed: a magenta quad depth-tested at NDC 0.9 masks
  // itself exactly to the buildings, silhouettes above the horizon included, and
  // leaves ground and sky untouched). So the fog is drawn as a LADDER of
  // depth-tested full-frame quads: shell i sits at eye distance t_i and paints
  // only where the scene is FURTHER than t_i. A pixel at distance d passes every
  // shell inside d, so its accumulated alpha is a staircase following
  // Beer-Lambert in d — per pixel, from real geometry. A tower's base and crown
  // are within ~2% of the same eye distance, so they now take the same fade.
  //
  // WHY THE GROUND IS STILL DONE IN SCREEN SPACE, and why that is not the old
  // bug: MapLibre's 2D fill layers do NOT write geometric depth. They write a
  // per-layer constant in a reserved band above everything 3D (probed: the 3D
  // depth range ends at 0.958984, the fills sit above it, cleared sky is 1.0).
  // So the ground cannot be fogged from the depth buffer at all — but for the
  // ground the screen-row argument IS sound, because the ground has no height.
  // The two are computed from the SAME Beer-Lambert on the SAME eye-space
  // distance, so they agree at every building's base by construction and there
  // is no seam to tune. The stencil buffer keeps them apart: one pass marks
  // every 3D pixel, the shells run where the mark is, the ground gradient runs
  // where it is not.
  //
  // WHY NOT MapLibre'S OWN FOG. Re-probed on 5.24.0 rather than trusted:
  // setting `fog-color` to magenta with `fog-ground-blend: 0` changed not one
  // pixel. `fog-*` is terrain-only and this scene has no terrain.
  //
  // The blend is now a real `over` (lerp toward the fog colour), not the old
  // `screen`. Screen could only add light, which is why the old haze could not
  // undo the excess it painted on a tower's lower half; a lerp is what aerial
  // perspective actually is, and at night it pulls the far city UP to the
  // skyglow instead of leaving it a black void.
  //
  // TASTE KNOBS, all of them (window.HAZE_TUNE):
  const HAZE = {
    on: new URLSearchParams(window.location.search).get('haze') !== '0',
    // 'depth'  — the ladder above (default)
    // 'screen' — the old DOM gradient, kept as a fallback and for A/B shots
    MODE: (new URLSearchParams(window.location.search).get('fog') === 'screen')
      ? 'screen' : 'depth',
    // Haze scale distance in metres — the distance at which a surface is
    // 1 - 1/e of the way to the sky colour. Smaller = thicker air.
    //
    // CALIBRATED, not re-guessed. The one thing he liked about the old haze was
    // the high view, "so if i go high enough so where the line is above the
    // towers in downtown it looks really nice like their distant and shaded
    // with the sky a bit". So the new curve is set to reproduce THAT AMOUNT at
    // THAT POSE: from 934 m up, the downtown towers sat at screen rows the old
    // gradient fed 4356 m of ground distance, giving alpha 0.365, while their
    // true camera distance was 2.67 km. Solving A(1-e^-2670/D) = 0.365 gives
    // D = 2507 m, i.e. 0.62x the old values — which is exactly what you would
    // expect, because the old screen-row curve was reading every building as
    // 1.6x further away than it was. Swept 1.0 / 0.6 / 0.42 / 0.3 on top of that
    // and 0.6 is also where the near field keeps its contrast.
    DIST: { day: 3200, golden: 2600, night: 2100 },
    // Alpha at infinity, i.e. at the horizon.
    MAX: { day: 0.62, golden: 0.58, night: 0.46 },
    // Rungs in the ladder. This is the ONLY source of banding in the depth
    // path: the staircase steps by MAX/(SHELLS+1) of alpha, which shows up as
    // faint contours on surfaces that span depth — roofs, never facades, since
    // a facade is at one distance. At 28 rungs the step is 0.02 alpha, about
    // 2.6 luma against a dark building under a bright sky, which is at the
    // threshold. Raising it costs one more full-frame depth+stencil test per
    // rung (most fragments are rejected before the shader runs).
    SHELLS: 28,
    // Each rung only needs to cover the frame ABOVE the ground row for its own
    // distance — nothing further away can appear below that row. This is the
    // whole reason the ladder is affordable: the far rungs shrink to a band at
    // the horizon. The pad extends the rung downward so that geometry cut BELOW
    // grade (the creek channel, PR #79) is still covered.
    SHELL_PAD: 0.09,
    // Pull the fog colour toward the sky's own zenith by this much, so the join
    // is to the sky ABOVE the horizon rather than to the horizon band — a
    // horizon band that matches the ground exactly reads as one flat wall.
    SKY_MIX: 0.22,
    // ── screen-mode fallback only ──
    MAX_DEPTH: 4.0,
    STOPS: 14,
  };
  window.HAZE_TUNE = HAZE;

  /** Camera altitude above the ground plane, in metres, from the live camera. */
  function cameraHeightM(map) {
    const H = map.getCanvas().clientHeight;
    const fov = map.getVerticalFieldOfView ? map.getVerticalFieldOfView() : 58;
    // MapLibre's own camera-to-centre distance, in pixels.
    const distPx = 0.5 * H / Math.tan(rad(fov) / 2);
    const lat = map.getCenter().lat;
    const mPerPx = 40075016.686 * Math.cos(rad(lat)) / (512 * Math.pow(2, map.getZoom()));
    return Math.max(1, distPx * Math.cos(rad(map.getPitch())) * mPerPx);
  }

  function parseCol(s, fallback) {
    if (typeof s !== 'string') return fallback;
    let m = /^#([0-9a-f]{6})$/i.exec(s.trim());
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(s);
    if (m) return [+m[1], +m[2], +m[3]];
    return fallback;
  }

  /** Interpolate a per-time-of-day number written as {day, golden, night}. */
  function todNum(tab, p) {
    return p <= 0.5 ? tab.day + (tab.golden - tab.day) * (p / 0.5)
                    : tab.golden + (tab.night - tab.golden) * ((p - 0.5) / 0.5);
  }

  /**
   * Rebuild the ground-haze gradient for this frame.
   *
   * `hz` is the horizon row in CSS px; it can be off the top or bottom of the
   * frame at extreme pitches, and both cases are handled by simply positioning
   * the element there and letting #sky's overflow clip it.
   */
  function updateGroundHaze(map, p, hz, W, H) {
    if (!elHaze) return;
    if (!HAZE.on) { elHaze.style.opacity = '0'; return; }
    const depthPx = Math.min(HAZE.MAX_DEPTH * H, H - hz);
    if (hz > H || depthPx < 2) { elHaze.style.opacity = '0'; return; }

    const fov = map.getVerticalFieldOfView ? map.getVerticalFieldOfView() : 58;
    const focalPx = 0.5 * H / Math.tan(rad(fov) / 2);
    const h = cameraHeightM(map);
    const D = todNum(HAZE.DIST, p);
    const A = todNum(HAZE.MAX, p);

    const col = fogColour(map);
    const c = `${Math.round(col[0])},${Math.round(col[1])},${Math.round(col[2])}`;

    const stops = [];
    for (let i = 0; i < HAZE.STOPS; i++) {
      // Bias the samples toward the horizon: that is where the curve moves.
      const t = Math.pow(i / (HAZE.STOPS - 1), 2);
      const dy = Math.max(0.35, t * depthPx);          // never exactly 0 -> sin(0)
      const ang = Math.atan(dy / focalPx);             // depression angle
      // h/sin, not h/tan: the depth path fades on distance FROM THE CAMERA, and
      // a fallback that fades on distance along the ground would disagree with
      // it by a factor of cos(depression) in the near field.
      const dist = h / Math.sin(ang);
      const a = A * (1 - Math.exp(-dist / D));
      stops.push(`rgba(${c},${a.toFixed(4)}) ${(t * 100).toFixed(2)}%`);
    }
    // THE SAME ROLL FIX AS THE SHADER, in the fallback path. A strip pinned to a
    // screen ROW is level by construction, so under a bank it disagrees with the
    // city exactly the way the depth path did. MapLibre rolls the world about
    // the view axis, i.e. about the frame centre, so rotating this element about
    // the frame centre by the same angle puts its edge back on the horizon.
    // `rotate` is CLOCKWISE for a positive angle and a positive roll lifts the
    // RIGHT end, so the angle is negated — the same sign, and the same measured
    // reason, as cameraRollSin.
    const rollDeg = map.getRoll ? (map.getRoll() || 0) : 0;
    // A rotated rectangle no longer covers the frame's corners. Grow it by the
    // swing the rotation costs, on both sides, rather than letting the fog stop
    // short in a wedge.
    const pad = rollDeg ? Math.abs(Math.tan(rad(rollDeg))) * H + 2 : 0;
    elHaze.style.opacity = '1';
    elHaze.style.width = (W + 2 * pad) + 'px';
    elHaze.style.height = (depthPx + pad) + 'px';
    elHaze.style.transformOrigin = `${(W / 2).toFixed(1)}px ${(H / 2).toFixed(1)}px`;
    elHaze.style.transform = `rotate(${(-rollDeg).toFixed(3)}deg) ` +
                             `translate(${(-pad).toFixed(1)}px, ${hz.toFixed(1)}px)`;
    elHaze.style.background = `linear-gradient(to bottom, ${stops.join(',')})`;
  }

  /** The fog colour for this hour: whatever timeofday.js last wrote to the sky,
   *  pulled SKY_MIX of the way toward the zenith. Read rather than duplicated —
   *  the ROUTES table in timeofday.js stays the one place these are authored. */
  function fogColour(map) {
    let sky = null;
    try { sky = map.getSky ? map.getSky() : null; } catch (e) {}
    const horiz = parseCol(sky && sky['horizon-color'], [200, 224, 240]);
    const zenith = parseCol(sky && sky['sky-color'], horiz);
    return mix(horiz, zenith, HAZE.SKY_MIX);
  }

  // ── The depth-tested fog ladder ───────────────────────────────────
  //
  // One `custom` layer, two programs, three kinds of pass per frame:
  //
  //   1. MASK   one quad at the far plane, depthFunc GREATER, colour writes off.
  //             It passes only where something 3D was drawn (everything 2D sits
  //             in a reserved depth band ABOVE the 3D range), and stamps 1 into
  //             the stencil there.
  //   2. SHELLS SHELLS quads at rising eye distances, depthFunc LESS, stencil
  //             EQUAL 1. Each paints where the scene is further than it is.
  //   3. GROUND one quad, stencil EQUAL 0, no depth test, alpha from the row's
  //             own eye distance. The ground has no height, so a row IS a
  //             distance for it.
  //
  // The whole thing is wrapped so that any failure — no stencil, a shader that
  // will not compile, a driver that refuses — falls back to the old DOM
  // gradient rather than showing nothing.
  const FOG_LAYER_ID = 'aerial-fog';
  const FOG_BIT = 0x80;              // the one stencil bit this file owns
  let fogGL = null, fogFailed = false, fogPlacing = false, _fogDrawnP = null;

  const VS_FLAT = `
    attribute vec2 a_unit;
    uniform float u_y0, u_z;
    varying vec2 v_ndc;
    void main() {
      vec2 n = vec2(a_unit.x * 2.0 - 1.0, mix(u_y0, 1.0, a_unit.y));
      v_ndc = n;
      gl_Position = vec4(n, u_z, 1.0);
    }`;
  const FS_FLAT = `
    precision mediump float;
    uniform vec4 u_col;                 // premultiplied
    void main() { gl_FragColor = u_col; }`;
  // The ground's eye-space distance for a row, derived rather than tuned. With
  // the world-up expressed in eye space as (0, cos p, sin p) for a view axis p
  // degrees below horizontal, a ray through NDC y hits the ground plane at
  //   t = h / (sin p - y * tan(fov/2) * cos p)
  // and t -> infinity exactly at the horizon, where the denominator vanishes.
  //
  // ...AND THAT IS ONLY TRUE WHEN THE CAMERA IS LEVEL. "the horizontal horizon
  // line tilts in the opposite direction as the map horizon when i move
  // sideways": the flight controller BANKS into a turn (controls.js, up to
  // TUNE.BANK_MAX degrees of roll), MapLibre rotates the whole rendered world
  // about the view axis, and this shader kept computing the horizon from the
  // screen ROW alone. So the fog's horizon stayed dead level while the city's
  // rolled — photographed at roll 15 deg as a hard horizontal edge straight
  // across a tilted skyline, which against a tilting world reads as a line
  // leaning the other way. `?haze=0` removed it, which is what named the layer.
  //
  // The fix is to ask for the ray's vertical component IN THE WORLD rather than
  // on the screen. Under a roll r the camera's own up is rotated about the view
  // axis, so the world-up in eye space becomes (-sin r cos p, cos r cos p,
  // sin p) and the y term picks up an x term. Written out, the horizon this
  // solves for is exactly the level horizon rotated by r about the frame
  // centre: slope aspect*tan(r) in NDC, intercept c/cos(r). No new taste value
  // and no fudge factor — it is the same derivation with one more angle in it.
  const FS_GROUND = `
    precision highp float;
    varying vec2 v_ndc;
    uniform float u_h, u_sinP, u_cosP, u_tanV, u_tanH, u_sinR, u_cosR, u_D, u_A;
    uniform vec3 u_fog;
    void main() {
      // The ray's rise per unit of forward travel, measured against the WORLD's
      // up rather than the screen's. u_sinR is 0 whenever the camera is level,
      // so this is the old expression exactly.
      float rise = v_ndc.y * u_tanV * u_cosR + v_ndc.x * u_tanH * u_sinR;
      float den = u_sinP - rise * u_cosP;
      if (den <= 0.0002) discard;       // at or above the horizon: sky, not ground
      float t = u_h / den;
      float a = u_A * (1.0 - exp(-t / u_D));
      gl_FragColor = vec4(u_fog * a, a);
    }`;

  function compile(gl, src, type) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error('fog shader: ' + gl.getShaderInfoLog(s));
    return s;
  }
  function program(gl, vs, fs, uniforms) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, vs, gl.VERTEX_SHADER));
    gl.attachShader(p, compile(gl, fs, gl.FRAGMENT_SHADER));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('fog link: ' + gl.getProgramInfoLog(p));
    const u = {};
    for (const n of uniforms) u[n] = gl.getUniformLocation(p, n);
    return { p, u, a: gl.getAttribLocation(p, 'a_unit') };
  }

  const fogLayer = {
    id: FOG_LAYER_ID,
    type: 'custom',
    renderingMode: '3d',

    onAdd(map, gl) {
      fogGL = {
        flat: program(gl, VS_FLAT, FS_FLAT, ['u_y0', 'u_z', 'u_col']),
        ground: program(gl, VS_FLAT, FS_GROUND,
          ['u_y0', 'u_z', 'u_h', 'u_sinP', 'u_cosP', 'u_tanV', 'u_tanH',
           'u_sinR', 'u_cosR', 'u_D', 'u_A', 'u_fog']),
        buf: gl.createBuffer(),
      };
      gl.bindBuffer(gl.ARRAY_BUFFER, fogGL.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    },

    onRemove(map, gl) {
      if (!fogGL) return;
      try {
        gl.deleteBuffer(fogGL.buf);
        gl.deleteProgram(fogGL.flat.p);
        gl.deleteProgram(fogGL.ground.p);
      } catch (e) {}
      fogGL = null;
    },

    render(gl, args) {
      if (!fogGL || !HAZE.on || HAZE.MODE !== 'depth' || !_map) return;
      try { drawFog(gl, args); } catch (e) {
        // One failure is enough: fall back for the rest of the session rather
        // than throwing sixty times a second.
        fogFailed = true;
        HAZE.MODE = 'screen';
        console.warn('[sky] depth fog failed, falling back to the screen gradient:', e);
      }
    },
  };

  function drawFog(gl, args) {
    const map = _map;
    const P = args.projectionMatrix;
    // Eye distance (in projection units) -> NDC z, straight off the matrix the
    // engine handed us rather than re-derived from nearZ/farZ. Verified in the
    // probe: t = nearZ gives -1.0000000 and t = farZ gives +0.9999999, and the
    // map centre at ground level lands at exactly this value for
    // t = cameraToCentreDistance.
    const ndcZ = t => (-P[10] * t + P[14]) / (-P[11] * t + P[15]);
    // One projection unit is one "camera pixel", so metres convert with the
    // same scale cameraHeightM uses. (Probed: clip.w for the centre point came
    // back as 676.51791 against a computed cameraToCentre of 676.518.)
    const lat = map.getCenter().lat;
    const mPerPx = 40075016.686 * Math.cos(rad(lat)) / (512 * Math.pow(2, map.getZoom()));
    const tanV = P[5] !== 0 ? 1 / P[5] : Math.tan(rad(58) / 2);
    // The HORIZONTAL half-angle, off the same matrix. Probed on this build at
    // roll 0, +15 and -15: P[0], P[1], P[4] and P[5] are bit-identical in all
    // three, P[1] and P[4] are exactly 0, and 1/P[0] equals tanV*(W/H) to seven
    // figures — so `args.projectionMatrix` is the PROJECTION alone, with no view
    // rotation in it. That is why the roll has to be applied by hand below, and
    // why reading tanH off P[0] is safe while doing it.
    const tanH = P[0] !== 0 ? 1 / P[0] : tanV * (map.getCanvas().clientWidth /
                                                 Math.max(1, map.getCanvas().clientHeight));
    const sinR = cameraRollSin(map);
    const cosR = Math.sqrt(Math.max(0, 1 - sinR * sinR));

    const pitch = map.getPitch();
    const sinP = Math.cos(rad(pitch));            // p = 90 - pitch, below horizontal
    const cosP = Math.sin(rad(pitch));
    const h = cameraHeightM(map);
    const D = todNum(HAZE.DIST, _p);
    const A = todNum(HAZE.MAX, _p);
    const col = fogColour(map);
    const fr = col[0] / 255, fg = col[1] / 255, fb = col[2] / 255;

    const K = Math.max(1, Math.round(HAZE.SHELLS));
    const farNdc = ndcZ(args.farZ);

    gl.bindBuffer(gl.ARRAY_BUFFER, fogGL.buf);
    gl.disable(gl.CULL_FACE);
    // A scissor left on by the layer before this one would clip every quad here
    // to somebody else's tile. `setCustomLayerDefaults` does not reset it.
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.STENCIL_TEST);

    // ── 1. mark every 3D pixel ──
    // The quad sits at the far plane. depthFunc GREATER therefore passes
    // wherever the stored depth is nearer than the far plane, which is exactly
    // the 3D geometry: MapLibre gives fill-extrusion the depth range [0,
    // 0.958984] and parks every 2D fill above it, with cleared sky at 1.0.
    const F = fogGL.flat;
    gl.useProgram(F.p);
    gl.enableVertexAttribArray(F.a);
    gl.vertexAttribPointer(F.a, 2, gl.FLOAT, false, 0, 0);
    gl.colorMask(false, false, false, false);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.depthFunc(gl.GREATER);
    // ONE BIT, not the whole byte. MapLibre keeps per-tile clipping ids in this
    // same buffer and tests them with a full-byte EQUAL, and it remembers within
    // a frame that it has already written them — so a plain clear here would
    // silently unclip any fill or line layer that a future pass puts after the
    // labels, with nothing to point at. gl.clear honours the stencil write mask,
    // so masking to 0x80 lets this borrow the top bit and hand the low seven
    // back untouched. Tile ids never reach 128 in this style.
    gl.stencilMask(FOG_BIT);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.stencilFunc(gl.ALWAYS, FOG_BIT, FOG_BIT);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.uniform1f(F.u.u_y0, -1);
    gl.uniform1f(F.u.u_z, 0.999999);
    gl.uniform4f(F.u.u_col, 0, 0, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ── 2. the ladder ──
    gl.colorMask(true, true, true, true);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);                  // premultiplied `over`
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthFunc(gl.LESS);
    gl.stencilMask(0x00);
    gl.stencilFunc(gl.EQUAL, FOG_BIT, FOG_BIT);
    for (let i = 1; i <= K; i++) {
      // Rungs at equal steps of alpha, so the staircase is uniform: the ith
      // rung is where Beer-Lambert has reached A*i/(K+1).
      const frac = i / (K + 1);
      const tM = -D * Math.log(1 - frac);
      const tPx = tM / mPerPx;
      if (!(tPx > 0) || tPx >= args.farZ) break;    // past the far plane: nothing there
      const z = ndcZ(tPx);
      if (!(z < farNdc)) break;
      // The per-rung alpha that makes the ACCUMULATION exact rather than the
      // rung: `over` composites multiplicatively, so alpha_i is chosen so that
      // 1 - prod(1 - alpha_j) lands on A*i/(K+1) after i rungs.
      const aStep = (A / (K + 1)) / (1 - A * (i - 1) / (K + 1));
      // Nothing further than tM can appear below the ground row for tM. Under a
      // roll that row is a TILTED line, so the rung has to start at the lowest
      // point of it — subtract the full swing the roll can add at |x| = 1, then
      // the existing pad. At roll 0 both terms vanish and this is unchanged.
      const y0 = cosP > 1e-3
        ? Math.max(-1, ((sinP - h / tM) / cosP - Math.abs(tanH * sinR)) /
                       (tanV * cosR) - HAZE.SHELL_PAD)
        : -1;
      if (y0 >= 1) continue;
      gl.uniform1f(F.u.u_y0, y0);
      gl.uniform1f(F.u.u_z, z);
      gl.uniform4f(F.u.u_col, fr * aStep, fg * aStep, fb * aStep, aStep);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ── 3. the ground, where nothing 3D was drawn ──
    const G = fogGL.ground;
    gl.useProgram(G.p);
    gl.enableVertexAttribArray(G.a);
    gl.vertexAttribPointer(G.a, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.stencilFunc(gl.EQUAL, 0, FOG_BIT);
    gl.uniform1f(G.u.u_y0, -1);
    gl.uniform1f(G.u.u_z, 0);
    gl.uniform1f(G.u.u_h, h);
    gl.uniform1f(G.u.u_sinP, sinP);
    gl.uniform1f(G.u.u_cosP, cosP);
    gl.uniform1f(G.u.u_tanV, tanV);
    gl.uniform1f(G.u.u_tanH, tanH);
    gl.uniform1f(G.u.u_sinR, sinR);
    gl.uniform1f(G.u.u_cosR, cosR);
    gl.uniform1f(G.u.u_D, D);
    gl.uniform1f(G.u.u_A, A);
    gl.uniform3f(G.u.u_fog, fr, fg, fb);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ── restore ──
    // MapLibre calls context.setDirty() after a custom layer, so it re-applies
    // its own state; the stencil CONTENTS are the one thing it would not clear
    // until the next frame, and the layers after this one are all symbol layers
    // that do not use tile clipping. Wiped anyway, on the principle that a
    // buffer nobody owns is a bug waiting for a new layer type.
    gl.stencilMask(FOG_BIT);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.stencilMask(0xFF);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    _fogDrawnP = _p;
  }

  /**
   * Where the fog belongs in the stack: after everything that writes depth,
   * before the labels (fogging a label makes it unreadable, and a label is not
   * at a distance anyway). Re-checked on `styledata` because layers are still
   * being added long after boot — the tiled outer ring and the LOD tiers both
   * append — and a fill-extrusion added ABOVE the fog would draw unfogged.
   */
  function fogBeforeId(map) {
    let layers = [];
    try { layers = map.getStyle().layers || []; } catch (e) { return undefined; }
    for (let i = layers.length - 1; i >= 0; i--) {
      if (layers[i].type !== 'symbol') return layers[i + 1] ? layers[i + 1].id : undefined;
    }
    return layers.length ? layers[0].id : undefined;
  }

  let fogAnchor = null;
  function placeFogLayer(map) {
    if (fogFailed || HAZE.MODE !== 'depth' || !HAZE.on || fogPlacing) return;
    fogPlacing = true;
    try {
      // The sky composites OVER the haze, exactly as the DOM overlay used to,
      // so when the sky layer is installed the fog anchors under IT rather than
      // under the labels. Anchoring both at the same id would make each one
      // shove the other down the stack on every `styledata`, forever.
      const before = (skyOn() && map.getLayer(SKY_LAYER_ID) ? SKY_LAYER_ID
                                                            : fogBeforeId(map)) || null;
      if (!map.getLayer(FOG_LAYER_ID)) {
        map.addLayer(fogLayer, before || undefined);
        fogAnchor = before;
      } else {
        // `getStyle()` omits custom layers entirely (probed: 189 layers before
        // and after adding one), so the real position has to come from the
        // style's own order. If that private field ever disappears, fall back
        // to re-anchoring only when the anchor itself changed — weaker, but it
        // still catches a layer appended past the labels.
        const order = map.style && map.style._order;
        let wrong;
        if (Array.isArray(order)) {
          const at = order.indexOf(FOG_LAYER_ID);
          const want = before ? order.indexOf(before) : order.length;
          wrong = at >= 0 && want >= 0 && at !== want - 1;
        } else {
          wrong = before !== fogAnchor;
        }
        if (wrong) { map.moveLayer(FOG_LAYER_ID, before || undefined); fogAnchor = before; }
      }
    } catch (e) {
      fogFailed = true;
      HAZE.MODE = 'screen';
      console.warn('[sky] could not install the depth fog layer:', e);
    }
    fogPlacing = false;
  }

  // ── The depth-tested sky compositor ───────────────────────────────
  //
  // THE BUG IT FIXES. Every sky element in this file used to be a DOM overlay
  // sitting on top of the whole map canvas, clipped to the horizon ROW and to
  // nothing else. A DOM overlay cannot know what is in front of it, so from a
  // pavement — where a shopfront fills the upper half of the frame — the star
  // field was painted straight across solid brick, and across tree canopies,
  // and down the face of a wall 1.5 m from the camera. At the old 18 m camera
  // floor the frame above the horizon was nearly always empty sky, which is why
  // this survived the whole life of the project.
  //
  // THE FIX IS THE SAME DEPTH BUFFER THE HAZE ALREADY USES, and it is a
  // compositing change, not an art change: the identical 2D canvas is uploaded
  // as a texture and drawn as ONE quad inside MapLibre's own render pass, at
  // NDC depth 0.999999 with depthFunc LESS. That is the exact complement of the
  // fog ladder's mask pass (GREATER at the same depth, which is measured to
  // select every 3D pixel and nothing else), so the sky lands on cleared sky
  // and on the ground and never on geometry. Nothing fades, nothing is
  // repositioned, no star is moved: pixels that were always wrong stop being
  // drawn.
  //
  // WHAT IS DELIBERATELY GIVEN UP. The file header used to argue that screen
  // blending was a feature — "a 97 m tower crossing the horizon line is never
  // hidden by the sky, it just picks up a little bloom". That glare is real,
  // but it belongs to the bloom pass in graphics.js (#fx-canvas), which reads
  // the rendered frame and adds light over everything including silhouettes.
  // Having the sky ALSO leak through solid geometry is not glare, it is a
  // missing depth test — and at 1.7 m it reads as stars on a brick wall.
  //
  // The composite is preserved exactly, and it is `over`, not the `screen` the
  // stylesheet asks for — see the long note on the blend func in drawSky().
  const SKY_LAYER_ID = 'sky-overlay';
  const SKY_COMP = {
    on: true,        // false restores the old DOM overlay, unchanged, in one line
    disc: true,      // the sun/moon core and its bloom go through the same pass
    // Just under the far plane. Anything MapLibre drew has a smaller stored
    // depth; cleared sky is exactly 1.0.
    z: 0.999999,
  };
  window.SKY_COMP = SKY_COMP;

  let skyGL = null, skyFailed = false, skyPlacing = false, skyAnchor = null;
  let skyDirty = true, skyTexW = 0, skyTexH = 0, _skyDrawnP = null;
  const skyOn = () => SKY_COMP.on && !skyFailed;

  const VS_TEX = `
    attribute vec2 a_unit;
    uniform vec4 u_rect;                 // x0, y0, x1, y1 in NDC
    uniform float u_z;
    varying vec2 v_uv;
    void main() {
      // v grows DOWN the source canvas, y grows UP in NDC, so the two are
      // mirrored. Getting this wrong puts the horizon wash at the zenith, which
      // is at least an unmistakable failure.
      v_uv = vec2(a_unit.x, 1.0 - a_unit.y);
      gl_Position = vec4(mix(u_rect.x, u_rect.z, a_unit.x),
                         mix(u_rect.y, u_rect.w, a_unit.y), u_z, 1.0);
    }`;
  const FS_TEX = `
    precision mediump float;
    uniform sampler2D u_tex;
    uniform vec4 u_tint;                 // premultiplied multiplier
    varying vec2 v_uv;
    void main() { gl_FragColor = texture2D(u_tex, v_uv) * u_tint; }`;

  /**
   * One radial-gradient sprite, alpha only, matching what the CSS element it
   * replaces actually painted. Two details are load-bearing and both were read
   * off the CSS rather than assumed: `radial-gradient(circle, ...)` sizes to
   * FARTHEST-CORNER, so 100% is the half-DIAGONAL of the square box, not the
   * half-width; and `#sky-core`/`#sky-bloom` carry `border-radius:50%`, so the
   * result is clipped to the inscribed circle.
   */
  function buildDiscSprite(stops) {
    const S = 128, R = S / 2;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g2 = c.getContext('2d');
    const g = g2.createRadialGradient(R, R, 0, R, R, R * Math.SQRT2);
    for (const [t, a] of stops) g.addColorStop(t, `rgba(255,255,255,${a})`);
    g2.fillStyle = g;
    g2.beginPath();
    g2.arc(R, R, R, 0, PI * 2);
    g2.fill();
    return c;
  }
  // The two profiles, copied stop for stop from the `place()` calls they
  // replace. Change them there and here together, or don't change them.
  const CORE_STOPS = [[0, 1], [0.42, 0.92], [0.72, 0]];
  const BLOOM_STOPS = [[0, 0.95], [0.26, 0.34], [0.68, 0]];

  function makeTex(gl, src) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    // The sky canvas is not a power of two and never will be: CLAMP + LINEAR
    // with no mipmap is the only filtering WebGL1 allows it.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (src) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    return t;
  }

  const skyLayer = {
    id: SKY_LAYER_ID,
    type: 'custom',
    renderingMode: '3d',

    onAdd(map, gl) {
      skyGL = {
        prog: program(gl, VS_TEX, FS_TEX, ['u_rect', 'u_z', 'u_tex', 'u_tint']),
        buf: gl.createBuffer(),
        tex: makeTex(gl, null),
        core: makeTex(gl, buildDiscSprite(CORE_STOPS)),
        bloom: makeTex(gl, buildDiscSprite(BLOOM_STOPS)),
      };
      gl.bindBuffer(gl.ARRAY_BUFFER, skyGL.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      skyTexW = skyTexH = 0;
      skyDirty = true;
    },

    onRemove(map, gl) {
      if (!skyGL) return;
      try {
        gl.deleteBuffer(skyGL.buf);
        gl.deleteProgram(skyGL.prog.p);
        gl.deleteTexture(skyGL.tex);
        gl.deleteTexture(skyGL.core);
        gl.deleteTexture(skyGL.bloom);
      } catch (e) {}
      skyGL = null;
    },

    render(gl) {
      if (!skyGL || !skyOn() || !_map || !canvas) return;
      try { drawSky(gl); } catch (e) {
        // Same contract as the fog: one failure retires the path for the
        // session and the DOM overlay comes back, rather than throwing sixty
        // times a second at a defect nobody can see.
        skyFailed = true;
        showDomSky(true);
        console.warn('[sky] depth-composited sky failed, falling back to the DOM overlay:', e);
      }
    },
  };

  function drawSky(gl) {
    const cv = _map.getCanvas();
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!(W > 0 && H > 0) || !(canvas.width > 0) || !(cssH > 0)) return;

    const P = skyGL.prog;
    gl.useProgram(P.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, skyGL.buf);
    gl.enableVertexAttribArray(P.a);
    gl.vertexAttribPointer(P.a, 2, gl.FLOAT, false, 0, 0);

    gl.disable(gl.CULL_FACE);
    // A scissor or a stencil left on by the layer before this one would clip
    // the sky to somebody else's tile. `setCustomLayerDefaults` resets neither.
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);

    // THE WHOLE FIX IS THESE THREE LINES.
    //
    // `gl.depthRange` is deliberately NOT touched. MapLibre hands a
    // renderingMode '3d' custom layer the same narrowed range it gives every
    // fill-extrusion — [0, 0.958984] on this build — so an NDC z of 0.999999
    // lands at the FAR END OF THE 3D BAND, above every building and below the
    // 1.0 the frame was cleared to. Widening the range back to [0,1] would put
    // the quad past the 2D layers' reserved band as well and the sky would stop
    // drawing over the ground. This is the same z, on the same range, that the
    // fog ladder's mask pass uses with GREATER; LESS is its exact complement.
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.depthFunc(gl.LESS);

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    // OVER, premultiplied — and this is `over` on purpose, MEASURED, not a
    // simplification of the `screen` the stylesheet asks for.
    //
    // style.css sets `mix-blend-mode: screen` on #sky-canvas, #sky-core and
    // #sky-bloom, and the file header has argued for years that screen is what
    // keeps a tower crossing the horizon from being painted over. IT HAS NEVER
    // RUN. `#sky` is `position:absolute; z-index:3`, which makes it a stacking
    // context, and a stacking context isolates the blending group — so every
    // one of those elements blends against an EMPTY backdrop inside #sky and
    // the group is then composited over the map with plain source-over.
    //
    // Probed rather than reasoned: three states (no sky / DOM sky / this layer)
    // at the same pose, solving `out = b + P(1-b)` for the implied source. On a
    // sky pixel beside the setting sun the DOM path implies a BLUE COMPONENT OF
    // -0.091 — a screen composite cannot darken anything, so the shipped path
    // is not screening. It is `over`, and it always was.
    //
    // Shipping a real screen here would have been a second change riding along
    // with the depth fix: measured at +26,+40,+38 on that same pixel, a
    // brighter sky nobody asked for. Whether the sky SHOULD screen is a taste
    // call for Simeon and a one-line edit in style.css, which is not this
    // lane's file. See HANDOFF §106.
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniform1f(P.u.u_z, SKY_COMP.z);
    gl.uniform1i(P.u.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);

    // ── the sky band ──
    gl.bindTexture(gl.TEXTURE_2D, skyGL.tex);
    if (skyDirty || skyTexW !== canvas.width || skyTexH !== canvas.height) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      skyTexW = canvas.width; skyTexH = canvas.height;
      skyDirty = false;
    }
    // The canvas is pinned to the top-left of the map and is `cssH` CSS pixels
    // tall — the sky band, not the viewport (see the note on resize()).
    const yBot = 1 - 2 * Math.min(cssH, H) / H;
    gl.uniform4f(P.u.u_rect, -1, yBot, 1, 1);
    gl.uniform4f(P.u.u_tint, 1, 1, 1, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ── the disc and its bloom ──
    // Same positions, sizes, colours and alphas the DOM elements were given;
    // the only difference is that these are depth-tested.
    if (SKY_COMP.disc && _disc) {
      const quad = (tex, sizePx, tint) => {
        const x0 = 2 * (_disc.x - sizePx / 2) / W - 1, x1 = 2 * (_disc.x + sizePx / 2) / W - 1;
        const y1 = 1 - 2 * (_disc.y - sizePx / 2) / H, y0 = 1 - 2 * (_disc.y + sizePx / 2) / H;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform4f(P.u.u_rect, x0, y0, x1, y1);
        gl.uniform4f(P.u.u_tint, tint[0], tint[1], tint[2], tint[3]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      };
      const c = _disc.col;
      if (_disc.bloomA > 0.005)
        quad(skyGL.bloom, _disc.bloomR * 2,
             [c.halo[0] / 255 * _disc.bloomA, c.halo[1] / 255 * _disc.bloomA,
              c.halo[2] / 255 * _disc.bloomA, _disc.bloomA]);
      if (_disc.coreA > 0.005)
        quad(skyGL.core, _disc.coreR * 2,
             [c.core[0] / 255 * _disc.coreA, c.core[1] / 255 * _disc.coreA,
              c.core[2] / 255 * _disc.coreA, _disc.coreA]);
    }

    // ── restore ──
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    _skyDrawnP = _p;
  }

  function skyBeforeId(map) { return fogBeforeId(map); }

  function placeSkyLayer(map) {
    if (!skyOn() || skyPlacing) return;
    skyPlacing = true;
    try {
      const before = skyBeforeId(map) || null;
      if (!map.getLayer(SKY_LAYER_ID)) {
        map.addLayer(skyLayer, before || undefined);
        skyAnchor = before;
      } else {
        // Custom layers are absent from `getStyle()` but present in the style's
        // own order — the same probe the fog placement runs on.
        const order = map.style && map.style._order;
        let wrong;
        if (Array.isArray(order)) {
          const at = order.indexOf(SKY_LAYER_ID);
          const want = before ? order.indexOf(before) : order.length;
          wrong = at >= 0 && want >= 0 && at !== want - 1;
        } else {
          wrong = before !== skyAnchor;
        }
        if (wrong) { map.moveLayer(SKY_LAYER_ID, before || undefined); skyAnchor = before; }
      }
      showDomSky(false);
    } catch (e) {
      skyFailed = true;
      showDomSky(true);
      console.warn('[sky] could not install the depth-composited sky layer:', e);
    }
    skyPlacing = false;
  }

  /**
   * The DOM overlay is the fallback, not a second copy: exactly one of the two
   * paths is visible at a time, or every star is drawn twice and the one that
   * ignores depth is the one on top.
   */
  let domSkyShown = null;
  function showDomSky(show) {
    if (domSkyShown === show) return;
    domSkyShown = show;
    // `visibility`, not `display`. A display:none element has no computed
    // transform in Chrome � it resolves to `none` � and sky.mjs's disc-position
    // assertion reads exactly that. The elements are still positioned and still
    // carry their opacity; they simply do not paint, which is the whole ask.
    if (canvas) canvas.style.visibility = show ? '' : 'hidden';
    for (const el of [elCore, elBloom])
      if (el) el.style.visibility = (show || !SKY_COMP.disc) ? '' : 'hidden';
  }

  // ── Overlay elements ──────────────────────────────────────────────
  let host = null, elGlow = null, elBloom = null, elCore = null, elHaze = null,
      canvas = null, ctx = null;
  let stars = null, clouds = null, haloSprite = null;
  let _map = null, _p = 0.12;
  // This frame's disc, published for the compositor. Null when there is no body
  // to draw, which is also what the DOM path expresses as opacity 0.
  let _disc = null;

  /**
   * One pre-rendered halo, blitted per bright star instead of building a fresh
   * radial gradient each time. Measured: the per-star createRadialGradient path
   * cost 1.62 ms/frame at night against 0.64 ms for day — the whole difference
   * was ~78 gradient objects per frame. drawImage of a cached sprite is a blit.
   */
  function buildHaloSprite() {
    const S = 32;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g2 = c.getContext('2d');
    const g = g2.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(210,228,255,1)');
    g.addColorStop(0.35, 'rgba(210,228,255,0.34)');
    g.addColorStop(1, 'rgba(210,228,255,0)');
    g2.fillStyle = g;
    g2.fillRect(0, 0, S, S);
    return c;
  }

  function seeded(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function buildStars() {
    const rnd = seeded(20260729);
    const out = [];
    // Biased LOW, not high. The first version weighted stars toward the zenith
    // "to keep the horizon clean" and the result was two visible stars: at a
    // flying pitch you only ever see the first ~20° above the horizon.
    for (let i = 0; i < 520; i++) {
      const az = rnd() * 360;
      const elev = 1.5 + Math.pow(rnd(), 1.5) * 62;
      // `v` is the unit vector for (az, elev), baked once. A star does not move.
      out.push({ az, elev, mag: 0.3 + Math.pow(rnd(), 2.6) * 0.7, v: dirOf(az, elev) });
    }
    return out;
  }

  function buildClouds() {
    const rnd = seeded(77712);
    const out = [];
    // Each cloud is a cluster of lobes rather than one blurred ellipse — a
    // single soft blob reads as a smudge on the glass, several overlapping ones
    // read as a cloud.
    for (let i = 0; i < 22; i++) {
      const az = rnd() * 360;
      // Clouds used to stop at 16.2 deg of elevation, which was right when the
      // camera stopped at pitch 85 minus an altitude penalty and only ever
      // showed a sliver of sky. With the ceiling at 88 the top of the frame is
      // 27 deg up at the default fov and 41 at the menu's maximum, and a sky
      // that is bare gradient above 16 reads as a backdrop rather than a sky.
      // Still biased LOW — the same lesson the stars learned at js/sky.js:232,
      // where weighting toward the zenith produced two visible stars — so the
      // horizon band keeps most of them and the high ones thin out.
      const elev = 2.2 + Math.pow(rnd(), 1.75) * 40;
      const span = 4 + rnd() * 9;
      const lobes = [];
      const n = 3 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const dAz = (rnd() - 0.5) * span;
        const dEl = (rnd() - 0.5) * 1.1;
        lobes.push({
          dAz, dEl,
          r: span * (0.30 + rnd() * 0.34),
          a: 0.5 + rnd() * 0.5,
          // Baked absolute direction, same reason as the stars: a lobe sits at
          // a fixed (az, elev) and only the CAMERA moves.
          v: dirOf(az + dAz, elev + dEl),
        });
      }
      // A cloud deck is a plane, not a dome: the higher up the sky you look, the
      // nearer and larger the cloud actually is, but it also thins as it stops
      // being seen edge-on. Fading with elevation is what keeps the new high
      // band from reading as the low band stamped overhead.
      const hi = Math.min(1, Math.max(0, (elev - 14) / 26));
      out.push({ az, elev, lobes, a: (0.45 + rnd() * 0.55) * (1 - 0.45 * hi),
                 squash: (0.30 + rnd() * 0.22) * (1 + 0.9 * hi), v: dirOf(az, elev) });
    }
    return out;
  }

  window.initSky = function initSky(map) {
    _map = map;
    host = document.getElementById('sky');
    if (!host) return;

    canvas = document.createElement('canvas');
    canvas.id = 'sky-canvas';
    host.appendChild(canvas);
    ctx = canvas.getContext('2d');

    // Order matters for screen blending: each of these adds light over
    // everything painted below it.
    // The ground haze is the one overlay that lives BELOW the horizon, so it
    // is not on the sky canvas (which is clipped to the sky) and it goes first:
    // screen blending is commutative, but keeping it under the sun means a
    // rendering-order change can never put haze over the disc.
    elHaze = document.createElement('div'); elHaze.id = 'sky-ground-haze';
    elHaze.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;' +
                           'mix-blend-mode:screen;will-change:transform,background';
    host.appendChild(elHaze);

    elGlow = document.createElement('div');  elGlow.id = 'sky-glow';   host.appendChild(elGlow);
    elBloom = document.createElement('div'); elBloom.id = 'sky-bloom'; host.appendChild(elBloom);
    elCore = document.createElement('div');  elCore.id = 'sky-core';   host.appendChild(elCore);

    stars = buildStars();
    clouds = buildClouds();
    haloSprite = buildHaloSprite();

    // Sky first, haze under it — placeFogLayer anchors itself to the sky layer
    // when there is one, so the two settle instead of chasing each other.
    placeSkyLayer(map);
    placeFogLayer(map);
    map.on('styledata', () => { placeSkyLayer(map); placeFogLayer(map); });

    const redraw = () => updateSky(map, _p);
    map.on('move', redraw);
    map.on('resize', redraw);
    resize();
    redraw();
  };

  /**
   * Size the canvas to the SKY BAND, not the viewport.
   *
   * Everything in this pass is already clipped to `hzPx + 0.018H` (see the clip
   * note in updateSky), so the rest of the element was pure waste — and not
   * cheap waste: a canvas whose contents change is re-uploaded to the GPU as a
   * texture every frame. Measured at 2560x1400: 13.7 MB/frame of which 98.2% was
   * transparent, 0.8 GB/s of bandwidth to move nothing. The band is at most
   * ~0.44H (pitch 85, the steepest the camera allows) and typically 0.06H at the
   * spawn pitch of 64.
   *
   * Height is quantised to STEP so pitching doesn't reallocate the backing store
   * every frame, and it only shrinks once two full steps of slack accumulate.
   */
  const STEP = 96;
  let cssH = 0;
  function resize(needCssH) {
    if (!canvas || !_map) return;
    const cv = _map.getCanvas();
    const w = cv.clientWidth, h = cv.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const want = Math.min(h, Math.max(STEP, Math.ceil((needCssH + 8) / STEP) * STEP));
    const grow = want > cssH, shrink = want <= cssH - 2 * STEP;
    if (canvas.width !== Math.round(w * dpr) || grow || shrink || !cssH) {
      cssH = want;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = cssH + 'px';
    }
    return dpr;
  }

  function rgba(c, a) { return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  /**
   * ── G10, THE INSTRUMENT budget.md §128 ASKED FOR ──
   *
   * `updateSky` measured at 8.8 % of all main-thread time at cruise and 93 % of
   * the whole `jumpTo` cascade (docs/perf/measured.md §1.2 FINDING 1) with no
   * counter, no timer and no way to test it. This is that counter. Same shape
   * as `__fly.outerField()`: cumulative total, worst case, and the call count
   * so a reader can difference two samples instead of trusting a running mean.
   */
  const SKY_METER = window.__sky = {
    calls: 0, ms: 0, maxMs: 0, lastMs: 0,
    memoHits: 0, memoMisses: 0, stars: 0, lobes: 0,
  };

  /**
   * ── THE HOUR MEMO: the sun does not move when the camera pans ──
   *
   * `updateSky` runs on every `move`, and `writeToMap()` ends in `map.jumpTo`
   * on every rAF tick while the controller is driving, so "on move" means "on
   * every frame" here (budget.md §128). Nearly everything it recomputed was a
   * function of the HOUR alone: the sun and moon tracks, every colour, every
   * alpha weight, the two big `radial-gradient(...)` CSS strings written into
   * the disc elements, the skyglow stops, the cloud lighting mix and all 264 of
   * the cloud gradient's colour strings. None of that changes when the camera
   * turns; all of it was rebuilt 60 times a second, and the string building in
   * particular is straight into the garbage collector, which the same profile
   * put at 9 % of main-thread time at dusk and 19 % on the phone viewport.
   *
   * So it is computed once per hour and reused. What stays per-frame is exactly
   * what the camera changes: the projections, the canvas size, the clip, the
   * horizon feather and the fades.
   *
   * `window.SKY_MEMO.on = false` is a live A/B switch — the same build with the
   * memo off recomputes everything every frame, which is what the before column
   * of any measurement here means.
   */
  const SKY_MEMO = { on: true };
  window.SKY_MEMO = SKY_MEMO;
  let _memo = null;

  /**
   * Star alpha strings, by thousandth. `rgba(238,244,255,${a.toFixed(3)})` ran
   * 520 times a frame and allocated a string every time; the twinkle means the
   * VALUE really does change per frame, so the fix is a table rather than a
   * cache. Indexing by `Math.round(a*1000)` reproduces `toFixed(3)`'s output
   * for every value except an exact half-thousandth tie, and the destination is
   * an 8-bit additive blend either way.
   */
  const STAR_RGBA = new Array(1001);
  function starFill(a) {
    let i = (a * 1000 + 0.5) | 0;
    if (i < 0) i = 0; else if (i > 1000) i = 1000;
    return STAR_RGBA[i] || (STAR_RGBA[i] = `rgba(238,244,255,${(i / 1000).toFixed(3)})`);
  }

  function hourMemo(p) {
    const G = window.GFX || {};
    const gs = (G.stars == null ? 1 : G.stars);
    const gc = (G.clouds == null ? 1 : G.clouds);
    // `ho` is in the key so SKY_TUNE.HANDOVER.ON is a LIVE switch — flipping it
    // from the console or a test rebuilds the hour instead of returning a memo
    // built under the other setting. A/B arms that silently share a cache are
    // how this repo once ran four "different" configurations identically.
    const ho = SKY_TUNE.HANDOVER.ON ? 1 : 0;
    if (SKY_MEMO.on && _memo && _memo.p === p && _memo.gs === gs && _memo.gc === gc && _memo.ho === ho) {
      SKY_METER.memoHits++;
      return _memo;
    }
    SKY_METER.memoMisses++;

    const B = window.skyBodies(p);
    const HO = SKY_TUNE.HANDOVER;
    const useMoon = !B.sunUp && B.moon.elev > -2;
    const body = useMoon ? B.moon : B.sun;
    const wSun = B.sun.elev >= 0 ? 1 : clamp01(1 + B.sun.elev / 20);
    const wMoon = Math.pow(clamp01((B.moon.elev + 3) / 9), 1.2);
    const moonHalo = HO.MOON_COL;

    // QUEUE Y20 — see SKY_TUNE.HANDOVER. `sunHalo` is the sun's OWN colour on
    // the sun's OWN schedule and is never switched, so the sun's two horizon
    // washes cannot change colour under a moon that has nothing to do with
    // them. `moonMix` is the continuous cross-fade for the one colour that IS
    // genuinely shared — the clouds — normalised from the same two weights the
    // washes already ride, so it inherits their continuity rather than adding a
    // third schedule to keep in step.
    const sunHalo = sunColour(B.sun.elev);
    const moonMix = HO.ON ? wMoon / Math.max(1e-6, wSun + wMoon) : (useMoon ? 1 : 0);

    // The disc is one element and cannot be in two places, so `useMoon` still
    // picks its body. That is free rather than papered over: the switch fires
    // exactly at moon.elev = -2, where the moon's own `vis` ramp is 0, and the
    // sun's is already 0 by then (sun.elev <= -1) — asserted by dusk.mjs's
    // handover check, so a taste edit that moves either ramp goes red rather
    // than quietly reintroducing a pop. Its COLOURS are each body's own.
    const coreCol = HO.ON
      ? (useMoon ? HO.MOON_CORE : sunColour(Math.max(B.sun.elev, 2)))
      : (useMoon ? [226, 234, 255] : sunColour(Math.max(B.sun.elev, 2)));
    const haloCol = HO.ON ? (useMoon ? moonHalo : sunHalo)
                          : (useMoon ? [150, 172, 226] : sunColour(B.sun.elev));
    const vis = useMoon ? clamp01((B.moon.elev + 2) / 6) : clamp01((B.sun.elev + 1) / 5);
    const coreR = useMoon ? 15 : 20;
    const bloomR = useMoon ? 130 : (170 + 190 * B.golden);

    const BELT = SKY_TUNE.BELT;
    const beltW = p <= BELT.P0 || p >= BELT.P2 ? 0
      : p <= BELT.P1 ? (p - BELT.P0) / (BELT.P1 - BELT.P0)
      : 1 - (p - BELT.P1) / (BELT.P2 - BELT.P1);

    const cloudA = (0.26 + 0.50 * B.golden) * (1 - B.night * 0.88);
    // The clouds are the one shared colour: they are lit by whatever is up, so
    // they cross-fade rather than switch (QUEUE Y20).
    const cloudLight = HO.ON ? mix(sunHalo, moonHalo, moonMix) : haloCol;
    const lit = mix([255, 255, 255], cloudLight, 0.35 + 0.45 * B.golden);
    const base = mix(lit, SKY_TUNE.CLOUD.BASE, SKY_TUNE.CLOUD.BASE_MIX * (1 - 0.55 * B.golden));
    const midCol = mix(lit, base, 0.6);

    // Per-lobe colour stops. `a = cloudA * cloud.a * lobe.a` and every one of
    // those three is fixed for an hour, so all 264 strings are too. Built once
    // here instead of 264 template literals per frame.
    const nClouds = Math.round(clouds.length * gc);
    const lobeStops = [];
    if (cloudA > 0.02 && nClouds > 0) {
      const CS = SKY_TUNE.CLOUD;
      for (let ci = 0; ci < nClouds; ci++) {
        const c = clouds[ci];
        const a0 = cloudA * c.a;
        const row = [];
        for (let k = 0; k < c.lobes.length; k++) {
          const a = a0 * c.lobes[k].a;
          row.push([rgba(lit, Math.min(1, a * CS.RIM)), rgba(midCol, a * 0.42), rgba(base, 0)]);
        }
        lobeStops.push(row);
      }
    }

    // The skyglow band's four stops: colour and alpha are hour-only; only the
    // two y coordinates move with the camera, and those are set at the call.
    const gs0 = 'rgba(150,160,196,0)';
    const gs1 = `rgba(150,160,196,${(0.014 * B.night).toFixed(4)})`;
    const gs2 = `rgba(228,164,110,${(0.032 * B.night).toFixed(4)})`;
    const gs3 = `rgba(255,176,96,${(0.052 * B.night).toFixed(4)})`;

    _memo = {
      p, gs, gc, ho, B, useMoon, body, coreCol, haloCol, moonHalo, moonMix,
      // The colour the SUN's own two horizon washes are painted in. With the
      // handover off this is the old switched `haloCol`, so the A/B arm really
      // is the pre-Y20 build and not a build carrying half the fix — which is
      // exactly the mistake the first run of y20-handover.mjs caught in me.
      sunHalo: HO.ON ? sunHalo : haloCol,
      wSun, wMoon, vis, coreR, bloomR,
      // The alpha the disc carries BEFORE the camera's own `discFade`.
      coreA0: vis,
      bloomA0: (useMoon ? 0.30 : 0.26 + 0.22 * B.golden) * vis,
      // The two CSS gradients written into the disc elements. Hour-only, and
      // each was a fresh ~120-character string plus a CSS parse every frame.
      coreBg: `radial-gradient(circle, ${rgba(coreCol, 1)} 0%, ${rgba(coreCol, 0.92)} 42%, ${rgba(coreCol, 0)} 72%)`,
      bloomBg: `radial-gradient(circle, ${rgba(haloCol, 0.95)} 0%, ${rgba(haloCol, 0.34)} 26%, ${rgba(haloCol, 0)} 68%)`,
      beltW,
      // The hour half of the two horizon washes; `fade` is multiplied in later.
      glowASun0: (0.26 + 0.40 * B.golden) * wSun,
      glowAMoon0: 0.17 * wMoon,
      hotASun0: (0.26 + 0.30 * B.golden) * wSun,
      hotAMoon0: 0.13 * wMoon,
      kWide: 1.5 + 0.7 * B.golden,
      // Direction vectors for the four wash anchors and the two body tracks.
      vBody: dirOf(body.az, Math.max(body.elev, -1.5)),
      vHzSun: dirOf(B.sun.az, 0.5),
      vHzMoon: dirOf(B.moon.az, 0.5),
      vRose: dirOf((B.sun.az + 180) % 360, SKY_TUNE.BELT.ROSE_ELEV),
      vBlue: dirOf((B.sun.az + 180) % 360, SKY_TUNE.BELT.BLUE_ELEV),
      nStars: Math.round(stars.length * gs), nClouds,
      cloudA, lit, base, midCol, lobeStops,
      glowStops: [gs0, gs1, gs2, gs3],
    };
    return _memo;
  }

  window.updateSky = function updateSky(map, p) {
    if (!host || !map) return;
    const _t0 = performance.now();
    _p = p;
    const M = hourMemo(p);
    const B = M.B;
    const project = projector(map);
    const pvec = project.vec;
    // The A/B switch reaches the hot loops too, so `SKY_MEMO.on = false` really
    // is the old code path and not just a cold memo — otherwise the before
    // column would already carry half the fix and under-report it.
    const memoOn = SKY_MEMO.on;
    const cv = map.getCanvas();
    const W = cv.clientWidth, H = cv.clientHeight;
    // Horizon first: it decides how tall the canvas has to be this frame.
    const hzPxEarly = horizonPx(map);
    const dpr = resize(Math.max(0, hzPxEarly) + 0.5 * SKY_TUNE.HORIZON_FADE * H) || 1;

    // Which body is lighting the sky, and in what colour. All hour-only — see
    // `hourMemo`, which also carries the two `radial-gradient(...)` strings and
    // the twilight weights whose derivation is preserved there and here:
    //
    // Twilight runs on TWO INDEPENDENT SCHEDULES, both always drawn.
    // The old single-body switch (`useMoon`) flipped in one frame at p=0.5925,
    // teleporting the horizon glow 176.6 deg from the western to the eastern
    // horizon and dropping its alpha 0.459 -> 0.168 — measured, and the most
    // watched moment of the 32 s auto cycle. The sun's afterglow now decays over
    // its own elevation while the moon's glow rises over its own, so they
    // cross over smoothly around p=0.685 with warm west and cool east on screen
    // at the same time, which is what dusk actually looks like.
    const useMoon = M.useMoon, body = M.body;
    const coreCol = M.coreCol, haloCol = M.haloCol, moonHalo = M.moonHalo;
    // QUEUE Y20: the sun's washes are painted in the SUN's colour, not in the
    // switched `haloCol`. Before this, the western afterglow changed colour in
    // one frame the moment the moon crossed -2 degrees — 83 levels of blue on
    // one notch of the shipped slider, which is what a visitor saw.
    const sunHalo = M.sunHalo;
    const wSun = M.wSun, wMoon = M.wMoon;

    // Fade the disc out as it approaches and crosses the horizon rather than
    // letting it pop.
    const vis = M.vis;

    const pos = pvec(M.vBody);
    const showDisc = pos.front && vis > 0.01;
    const discFade = pos.fade;

    // Core disc — small and bright.
    const coreR = M.coreR;
    place(elCore, pos, coreR * 2, showDisc ? M.coreA0 * discFade : 0, M.coreBg);

    // Bloom — wide, soft, the part that actually reads.
    const bloomR = M.bloomR;
    const bloomA = M.bloomA0 * discFade;
    place(elBloom, pos, bloomR * 2, showDisc ? bloomA : 0, M.bloomBg);

    // The horizon glow now lives in the canvas rather than a fourth
    // screen-blended DOM layer, so all of it composites in one pass.
    place(elGlow, { x: 0, y: 0 }, 1, 0, 'none');

    // Hand the disc to the depth-tested compositor. Same numbers the two
    // `place()` calls above just used — this is the SAME disc drawn in a pass
    // that can be occluded, not a second one.
    _disc = showDisc ? {
      x: pos.x, y: pos.y,
      coreR, coreA: vis * discFade,
      bloomR, bloomA,
      col: { core: coreCol, halo: haloCol },
    } : null;

    // ── Canvas pass ──
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, cssH);
    ctx.globalCompositeOperation = 'lighter';

    const S = Math.max(W, H);
    const hzPx = hzPxEarly;

    // Aerial perspective. In `depth` mode the whole thing lives in the custom
    // layer and reads the live camera itself, so there is nothing to push at it
    // from here and the DOM element must be off — leaving it up would fog every
    // building a SECOND time, by screen row, which is the defect. In `screen`
    // mode the old DOM gradient runs, in this pass rather than its own listener:
    // two listeners on `move` can land either side of each other and the haze
    // would lag the horizon by a frame while tilting.
    if (HAZE.MODE === 'depth') {
      if (elHaze) elHaze.style.opacity = '0';
      // The layer reads the hour itself at draw time, so the only thing that can
      // go stale is a tod change with no other reason to repaint. Ask for one
      // frame, once — comparing against what was actually DRAWN, not against a
      // request, so this can never become a self-feeding render loop.
      // ...and only while there is a layer to draw it. With `?haze=0` nothing
      // ever sets _fogDrawnP, so an unguarded compare asks for a repaint on
      // every single updateSky forever.
      if (HAZE.on && !fogFailed && _fogDrawnP !== p) map.triggerRepaint();
    } else {
      updateGroundHaze(map, p, hzPx, W, H);
    }

    // CLIP EVERYTHING IN THE SKY PASS TO THE SKY. The horizon washes are
    // ellipses centred on the horizon line, so without this half of each one
    // lands on the city: at dusk an 825x561 px lobe of deep red at 0.31 alpha
    // screen-blended the entire frame magenta, ground included. Light on the
    // buildings is setLight's job and the baked golden palette's job; the sky's
    // job stops at the horizon.
    //
    // The clip runs HALF of HORIZON_FADE below the horizon and that overhang is
    // erased again after the pass — see the note on HORIZON_FADE. Clipping is
    // still what stops the wash reaching the whole frame; the erase is only what
    // stops the clip's own edge being a line across the towers.
    const fadePx = SKY_TUNE.HORIZON_FADE * H;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, Math.max(0, hzPx + 0.5 * fadePx));
    ctx.clip();

    /** One elliptical glow lobe, additively composited. */
    function drawGlow(pos, rx, ry, alpha, col, stops) {
      if (!pos.front || !(alpha > 0.004) || rx < 2 || ry < 1) return;
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.scale(1, ry / rx);
      // Gradient built AFTER the transform, centred on the origin — see the
      // note in the cloud pass; building it before lands it off the shape.
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      for (const [t, m] of stops) g.addColorStop(t, rgba(col, alpha * m));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // City skyglow floor: an omnidirectional warm lift at the horizon. Drawn
    // first so stars and clouds sit on top of it. This is what stops the night
    // sky being a flat near-black bar, and (being additive) it washes out the
    // faintest low stars exactly as real skyglow does.
    if (B.night > 0.02) {
      const band = 7.5 * (H / (map.getVerticalFieldOfView ? map.getVerticalFieldOfView() : 58));
      const y0 = hzPx - band, y1 = hzPx + 0.012 * H;
      if (y1 > 0 && y0 < H) {
        const gs = M.glowStops;
        const g = ctx.createLinearGradient(0, y0, 0, y1);
        g.addColorStop(0.00, gs[0]);
        g.addColorStop(0.45, gs[1]);
        g.addColorStop(0.78, gs[2]);
        g.addColorStop(1.00, gs[3]);
        ctx.fillStyle = g;
        ctx.fillRect(0, y0, W, y1 - y0);
      }
    }

    // Belt of Venus — the dusk band on the horizon OPPOSITE the sun. Two
    // stacked lobes: rose above, the cool earth-shadow lift below it. Drawn
    // before the body washes so those stay on top.
    const BELT = SKY_TUNE.BELT;
    const beltW = M.beltW;
    if (beltW > 0.02) {
      const rosePos = pvec(M.vRose);
      const bluePos = pvec(M.vBlue);
      drawGlow(rosePos, BELT.RX * S, BELT.RY_ROSE * S,
        BELT.ROSE_A * beltW * rosePos.fade, BELT.ROSE, BELT.STOPS);
      drawGlow(bluePos, BELT.RX * S * 0.9, BELT.RY_BLUE * S,
        BELT.BLUE_A * beltW * bluePos.fade, BELT.BLUE, BELT.STOPS);
    }

    // Wide washes — one per body, anchored to its AZIMUTH at the horizon, so
    // the sky brightens in the right direction even when the disc is off-screen.
    const hzSun = pvec(M.vHzSun);
    const hzMoon = pvec(M.vHzMoon);
    const kWide = M.kWide;
    const WIDE = [[0, 0.9], [0.34, 0.28], [0.70, 0]];
    const glowASun = M.glowASun0 * hzSun.fade;
    const glowAMoon = M.glowAMoon0 * hzMoon.fade;
    drawGlow(hzSun,  0.5 * S * kWide, 0.15 * S * kWide, glowASun,  sunHalo,  WIDE);
    drawGlow(hzMoon, 0.5 * S * 1.5,   0.15 * S * 1.5,   glowAMoon, moonHalo, WIDE);

    // Tight hot-spot at the same anchor. The wide wash alone is structurally
    // incapable of reading at the default pitch: at ~2600 px across, its
    // gradient parameter never exceeds ~0.07 over the 48 px of visible sky, so
    // it is a flat tint with no falloff anywhere in frame. This lobe is sized so
    // a real falloff lands inside that band — the difference between "the sky is
    // orange" and "the sun is setting over there".
    const HOT = [[0, 1], [0.30, 0.45], [0.62, 0.12], [1, 0]];
    const hotASun = Math.min(0.60, M.hotASun0 * hzSun.fade);
    const hotAMoon = Math.min(0.60, M.hotAMoon0 * hzMoon.fade);
    drawGlow(hzSun, 0.16 * S, 0.042 * S, hotASun, sunHalo, HOT);
    drawGlow(hzMoon, 0.16 * S, 0.042 * S, hotAMoon, moonHalo, HOT);

    // Star and cloud counts are quality settings (graphics.js). Both arrays are
    // built from a seeded shuffle, so a prefix is an unbiased random subset —
    // no need to regenerate anything when the slider moves.
    const nStars = M.nStars;
    const nClouds = M.nClouds;

    // Stars ride `B.stars`, NOT `B.night` — see SKY_TUNE.DUSK. On the old gate
    // the field was already at 20% alpha at p=0.62, when the sun is 5.8° down
    // and a real sky holds Venus and nothing else; the sweep read them as
    // "stars visible" in five separate dusk frames and they were most of why
    // the midpoint looked like midnight.
    if (B.stars > 0.02 && nStars > 0) {
      const TW = SKY_TUNE.TWINKLE;
      const now = performance.now();
      let drawn = 0;
      for (let si = 0; si < nStars; si++) {
        const s = stars[si];
        const q = memoOn ? pvec(s.v) : project(s.az, s.elev);
        if (!q.front || q.x < -8 || q.x > W + 8 || q.y < -8 || q.y > H) continue;
        drawn++;
        let a = B.stars * s.mag;
        // Twinkle rides the existing redraw (camera moves, the auto cycle) —
        // deliberately NO dedicated loop, so a parked sky stays free and
        // simply holds still. Phase from the star's azimuth, rate from its
        // magnitude, so the field shimmers instead of pulsing in unison.
        if (s.mag > TW.MAG) {
          a *= 1 - TW.AMP * (0.5 + 0.5 * Math.sin(now * TW.SPEED * (0.6 + s.mag) + s.az * 7.3));
        }
        const r = 0.55 + s.mag * 1.25;
        ctx.fillStyle = memoOn ? starFill(a) : `rgba(238,244,255,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(q.x, q.y, r, 0, PI * 2);
        ctx.fill();
        // The brightest handful get a small halo so the field has hierarchy
        // instead of reading as uniform noise. Blitted from a cached sprite.
        if (s.mag > 0.82 && haloSprite) {
          const d = r * 10;
          ctx.globalAlpha = a * 0.5;
          ctx.drawImage(haloSprite, q.x - d / 2, q.y - d / 2, d, d);
          ctx.globalAlpha = 1;
        }
      }
      SKY_METER.stars = drawn;
    }

    // Clouds: lit from the side the body is on, so they warm up at golden hour.
    // `cloudA`, the lit/base colours and all 264 gradient stop strings are
    // hour-only and come from the memo; the geometry below is per-frame.
    const cloudA = M.cloudA;
    if (cloudA > 0.02 && nClouds > 0) {
      const CS = SKY_TUNE.CLOUD;
      const degPx = (() => {                    // pixels per degree, near centre
        const a = project(map.getBearing(), 0), b2 = project(map.getBearing() + 1, 0);
        return (a.front && b2.front) ? Math.max(2, Math.abs(b2.x - a.x)) : 12;
      })();
      let lobesDrawn = 0;
      for (let ci = 0; ci < nClouds; ci++) {
        const c = clouds[ci];
        const q = memoOn ? pvec(c.v) : project(c.az, c.elev);
        if (!q.front || q.x < -W || q.x > W * 2) continue;
        const stopsFor = M.lobeStops[ci];
        // Direction from this cloud toward the lighting body, in (az, elev)
        // space — a proxy for screen direction that keeps working when the
        // body itself is off-screen. The azimuth term is CLAMPED and scaled
        // by cos(elev): raw az differences span ±180° and drowned out the
        // elevation term entirely (measured: a 64°-high noon sun produced a
        // 0.5 px top-light tilt because far-azimuth clouds read the light as
        // sideways). A high day sun lights cloud TOPS; a setting sun lights
        // their UNDERSIDES.
        const dAzRaw = ((body.az - c.az + 540) % 360) - 180;
        const dAzL = clamp(dAzRaw, -60, 60) * Math.cos(rad(Math.max(0, body.elev)));
        const dElL = body.elev - c.elev;
        const Ld = Math.hypot(dAzL, dElL) || 1;
        const lx = dAzL / Ld, ly = -dElL / Ld;   // screen y grows downward
        for (let li = 0; li < c.lobes.length; li++) {
          const lb = c.lobes[li];
          const lq = memoOn ? pvec(lb.v) : project(c.az + lb.dAz, c.elev + lb.dEl);
          if (!lq.front) continue;
          const r = lb.r * degPx;
          if (r < 3 || r > W * 1.5) continue;
          const stops = stopsFor[li];
          lobesDrawn++;
          ctx.save();
          ctx.translate(lq.x, lq.y);
          ctx.scale(1, c.squash);
          // Build the gradient AFTER the transform, centred on the origin —
          // a gradient created in untransformed space then translated/scaled
          // lands nowhere near the shape it is meant to fill. The INNER
          // circle is offset toward the light IN LOCAL COORDS — a first cut
          // "de-squashed" the y offset (divided by squash) to chase screen
          // proportions and pushed the inner point OUTSIDE the outer circle
          // (|offset| up to 1.16r), a degenerate cone that erased the shading
          // it was meant to create. Local units keep it inside: the offset is
          // proportional to the ellipse's own short axis.
          const off = CS.OFFSET * r;
          const g = ctx.createRadialGradient(lx * off, ly * off, 0, 0, 0, r);
          g.addColorStop(0, stops[0]);
          g.addColorStop(0.55, stops[1]);
          g.addColorStop(1, stops[2]);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(0, 0, r, 0, PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
      SKY_METER.lobes = lobesDrawn;
    }
    ctx.restore();                       // end sky clip

    // Feather the bottom edge back out. `destination-out` with a 0 -> 1 alpha
    // ramp removes that fraction of everything already drawn, so the wash runs
    // out smoothly across the horizon instead of ending on a row. Done once over
    // the band rather than per lobe, so stars, clouds, the belt and both body
    // washes all land on the same falloff.
    if (fadePx > 1 && hzPx + 0.5 * fadePx > 0) {
      const y0 = Math.max(0, hzPx - 0.5 * fadePx);
      const y1 = hzPx + 0.5 * fadePx;
      ctx.globalCompositeOperation = 'destination-out';
      const g = ctx.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      // Ease rather than ramp linearly: a straight ramp still leaves a visible
      // corner where it starts, because the eye finds the DISCONTINUITY IN
      // SLOPE, not just in value.
      g.addColorStop(0.35, 'rgba(0,0,0,0.18)');
      g.addColorStop(0.70, 'rgba(0,0,0,0.72)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = g;
      ctx.fillRect(0, y0, W, y1 - y0);
    }
    ctx.globalCompositeOperation = 'source-over';

    // The compositor's texture IS this canvas, so it is stale until a frame is
    // drawn. `move` already lands before the render that follows it; a
    // time-of-day change has nothing behind it, so ask for one frame. This
    // cannot feed itself — triggerRepaint does not fire `move`.
    skyDirty = true;
    // `window.SKY_COMP.on = false` is a live A/B switch, not just a boot flag —
    // both a verification and Simeon can put the old overlay back in one line.
    showDomSky(!(skyOn() && skyGL));
    // ...and the repaint request is guarded on the HOUR, exactly the way the
    // fog's is, not asked for on every call. A camera move is already followed
    // by a render, so an unconditional request adds a redundant frame to every
    // single move — measured as four failures in `sky.mjs` (two setLight
    // mismatches ~1 deg and a shadow hull that had not re-tiled inside the
    // test's 6 s idle window) that all went green again once this was gated.
    // Comparing against what was DRAWN, not what was asked for, is what stops
    // it becoming a self-feeding render loop.
    if (skyOn() && skyGL && _skyDrawnP !== p) map.triggerRepaint();

    // ── Hand the frame to the post-process pass ──
    // graphics.js needs the sun's screen position, and it must run in the SAME
    // pass: registering its own map.on('move') would recompute an identical
    // projection and could land either side of this one, so god rays would lag
    // the sun by a frame while turning. Publishing the frame and calling
    // straight through makes the ordering impossible to get wrong.
    window.skyFrame = {
      W, H, dpr, horizonPx: hzPx,
      sun: { x: pos.x, y: pos.y, front: !useMoon && pos.front, fade: pos.fade, elev: B.sun.elev, az: B.sun.az },
      moonUp: useMoon, colour: coreCol, haloColour: haloCol,
      golden: B.golden, night: B.night, lamps: B.lamps, stars: B.stars, p,
    };
    if (typeof window.renderFX === 'function') window.renderFX(map, window.skyFrame);

    // G10. Note this INCLUDES renderFX (and therefore graphics.js's aeMeter),
    // because that is what a caller actually pays for calling updateSky. The
    // sky's own canvas pass is `ms - the post-process`, which graphics.js
    // publishes separately.
    const _ms = performance.now() - _t0;
    SKY_METER.calls++;
    SKY_METER.ms += _ms;
    SKY_METER.lastMs = _ms;
    if (_ms > SKY_METER.maxMs) SKY_METER.maxMs = _ms;
  };

  function place(el, pos, sizePx, alpha, background) {
    if (!el) return;
    if (!(alpha > 0.005)) { el.style.opacity = '0'; return; }
    el.style.opacity = String(alpha);
    // Writing the same values back costs a style recalc for nothing, and
    // `background` in particular is a ~120-character gradient the engine
    // re-parses on every assignment. Both are hour-only; the transform is not.
    if (el.__skyW !== sizePx || !SKY_MEMO.on) {
      el.__skyW = sizePx;
      el.style.width = sizePx + 'px';
      el.style.height = sizePx + 'px';
    }
    if (el.__skyBg !== background || !SKY_MEMO.on) {
      el.__skyBg = background;
      el.style.background = background;
    }
    el.style.transform = `translate(${(pos.x - sizePx / 2).toFixed(1)}px, ${(pos.y - sizePx / 2).toFixed(1)}px)`;
  }
})();
