/**
 * Expressions embed widget — single file, no build step.
 */
(function (global) {
  "use strict";

  var PLATE = 1024;
  var PULL_TAP = 0.05;
  var PULL_PAIN = 0.09;
  var GAZE_NEAR = 0.24;
  var MOUSE_REST_MS = 120;
  var HOVER_CURIOUS_MS = 160;
  var GRAB_FADE_MS = 80;
  var TAP_CURIOUS_MS = 350;
  var SMILE_RETURN_MS = 260;
  var GAZE_CUT_MS = 60;
  var NAUSEA_FOUR_MS = 2600;
  var NAUSEA_WINDOW_MS = 9000;
  var SPRING_REDUCE_MS = 200;
  var SPRING_SETTLE_MS = 700;
  var SPRING_OVERSHOOT = 0.15;
  var _springLn = Math.log(SPRING_OVERSHOOT);
  var SPRING_ZETA =
    -_springLn / Math.sqrt(Math.PI * Math.PI + _springLn * _springLn);
  // Envelope is ~0.1% at 700ms, so a long pull is visually home inside that window.
  var SPRING_WN =
    -Math.log(0.001) / (SPRING_ZETA * (SPRING_SETTLE_MS / 1000));
  var GRID = 10;
  var SHEET_CELLS = 64;
  var COARSE = 32;
  var PAD_FRAC = 0.3;
  var RUBBER_KNEE = 0.6;
  // Canonical crop: the head is the middle of the plate. No face detection.
  // Ellipse covers hair, ears, and chin. The neck is the base of that ellipse.
  var HEAD_CX = 512;
  var HEAD_CY = 480;
  var HEAD_RX = 320;
  var HEAD_RY = 360;
  var NECK_Y = 800;
  var HEAD_FALLOFF = 0.08;
  // Crown-level shift along the rubber-banded pull. Half the pull, and never
  // more than about 0.08 of the plate, so a long drag cannot walk the skull
  // off the frame. The neck lever scales this down toward the chin.
  var HEAD_SHIFT_GAIN = 0.5;
  var HEAD_SHIFT_CAP = 0.08;
  // Soft sheet. A grab is a brush on the already-deformed picture; the rest
  // of the head is a damped membrane, so a pull travels through the features
  // instead of stopping at a circle. Nodes outside the head stay pinned.
  // ü = c²∇²u − ω²u − γu̇ + ν∇²u̇
  // Overall-shape fluidity is reach and flesh (how far and how viscously the
  // silhouette flows) against hz and damp (how fast it returns, how little it
  // sloshes). These four are 15% less fluid than the previous tune.
  var SHEET_HZ = 2.645;
  var SHEET_REACH = 0.07225;
  var SHEET_DAMP = 0.161;
  var SHEET_FLESH = 0.2975;
  var SHEET_HARDEST = 8;
  var SHEET_GRIP = 2500;
  var SHEET_HANDFUL = 0.085;
  var SHEET_MAX_STEPS = 48;

  function photoRect(width, height) {
    var denom = 1 + 2 * PAD_FRAC;
    var inset = PAD_FRAC / denom;
    var span = 1 / denom;
    return {
      x: width * inset,
      y: height * inset,
      w: width * span,
      h: height * span,
    };
  }

  function nowDefault() {
    return Date.now();
  }

  function absoluteUrl(url) {
    try {
      return new URL(url).href;
    } catch (e) {
      var loc = (global.location && global.location.href) || "http://localhost/";
      return new URL(url, loc).href;
    }
  }

  function resolveUrl(relative, manifestUrl) {
    return new URL(relative, absoluteUrl(manifestUrl)).href;
  }

  function manifestDirectory(manifestUrl) {
    var u = new URL(manifestUrl);
    var p = u.pathname;
    var slash = p.lastIndexOf("/");
    return u.origin + p.slice(0, slash + 1);
  }

  function collectFetchUrls(manifest, manifestUrl) {
    var urls = [absoluteUrl(manifestUrl)];
    var base = manifestUrl;
    var plates = manifest.plates || {};
    for (var k in plates) {
      if (Object.prototype.hasOwnProperty.call(plates, k) && plates[k]) {
        urls.push(resolveUrl(plates[k], base));
      }
    }
    if (manifest.gaze && manifest.gaze.sheet) {
      urls.push(resolveUrl(manifest.gaze.sheet, base));
    }
    return urls;
  }

  function allowedOrigins(urls) {
    var set = Object.create(null);
    for (var i = 0; i < urls.length; i++) {
      try {
        set[new URL(urls[i]).origin] = true;
      } catch (_) {}
    }
    return set;
  }

  function createFetchGuard(allowed) {
    return function guardedFetch(input) {
      var href =
        typeof input === "string"
          ? input
          : input && input.url
            ? input.url
            : String(input);
      var origin;
      try {
        origin = new URL(href).origin;
      } catch (e) {
        throw e;
      }
      if (!allowed[origin]) {
        return Promise.reject(new Error("fetch blocked: " + href));
      }
      return fetch(input);
    };
  }

  function pickGazeCell(manifest, pointerPlateX, pointerPlateY, betweenX, betweenY) {
    var dx = pointerPlateX - betweenX;
    var dy = pointerPlateY - betweenY;
    var dist = Math.hypot(dx, dy);
    if (dist < PLATE * GAZE_NEAR) {
      return manifest.gaze ? manifest.gaze.center : 12;
    }
    var angle = Math.atan2(dy, dx);
    var cols = 5;
    var rows = 5;
    var col = Math.round(((angle / Math.PI + 1) / 2) * (cols - 1));
    var row = Math.round(((dy / PLATE + 0.5) * (rows - 1)));
    col = Math.max(0, Math.min(cols - 1, col));
    row = Math.max(0, Math.min(rows - 1, row));
    return row * cols + col;
  }

  /**
   * Interaction state machine (testable).
   */
  function createEngine(manifest, opts) {
    opts = opts || {};
    var clock = opts.now || nowDefault;
    var rand = opts.random || Math.random;
    var reduced = !!opts.reducedMotion;

    var settled = "smile";
    var display = "smile";
    var displayUntil = 0;
    var grabbing = false;
    var pull = 0;
    var pointerType = "mouse";
    var pointerOnFace = false;
    var pointerPlateX = 512;
    var pointerPlateY = 512;
    var pointerMoving = false;
    var lastMoveAt = clock();
    var restSince = 0;
    var nauseaPulls = [];
    var nauseaUntil = 0;
    var springHome = false;
    var springStart = 0;
    var keyboardTugActive = false;
    var keyboardTugStep = 0;
    var cancelled = false;
    var gazeCell = manifest.gaze ? manifest.gaze.center : 12;
    var lastGazeSwap = 0;
    var forwardHoldUntil = 0;
    var blinkNext = clock() + 2400 + rand() * 3800;
    var blinkPhase = null;

    function trimNauseaPulls(t) {
      nauseaPulls = nauseaPulls.filter(function (p) {
        return t - p.t < NAUSEA_WINDOW_MS;
      });
    }

    function startNausea(t, durationMs) {
      settled = "nausea";
      display = "nausea";
      nauseaUntil = t + durationMs;
      displayUntil = nauseaUntil + SMILE_RETURN_MS;
    }

    function releaseFace(t, releasePull) {
      grabbing = false;
      springHome = true;
      springStart = t;
      if (cancelled) {
        cancelled = false;
        return;
      }
      if (releasePull < PULL_TAP) {
        settled = "curious";
        display = "curious";
        displayUntil = t + TAP_CURIOUS_MS;
        return;
      }
      trimNauseaPulls(t);
      nauseaPulls.push({ t: t, pull: releasePull });
      var count = nauseaPulls.length;
      var duration =
        count >= 4 ? NAUSEA_FOUR_MS : 500 + releasePull * 2200;
      if (count >= 4) {
        nauseaPulls = [];
      }
      startNausea(t, duration);
    }

    return {
      manifest: manifest,
      tick: function (t) {
        if (keyboardTugActive) {
          return;
        }
        if (display === "curious" && settled === "curious" && displayUntil > 0 && t >= displayUntil) {
          if (!grabbing && !pointerOnFace) {
            settled = "smile";
            display = "smile";
            displayUntil = 0;
          }
        }
        if (display === "nausea" && t >= nauseaUntil) {
          display = "smile";
          settled = "smile";
          if (t >= displayUntil) displayUntil = 0;
        }
        if (
          pointerType === "mouse" &&
          pointerOnFace &&
          !grabbing &&
          settled === "smile" &&
          display === "smile"
        ) {
          if (!restSince) restSince = t;
          if (t - restSince >= MOUSE_REST_MS) {
            settled = "curious";
            display = "curious";
            displayUntil = 0;
          }
        } else if (!pointerOnFace || pointerType !== "mouse") {
          restSince = 0;
        }

        if (
          settled === "smile" &&
          display === "smile" &&
          !grabbing &&
          !reduced
        ) {
          if (t >= blinkNext) {
            blinkPhase = "half";
            blinkNext = t + 4000 + rand() * 2200;
          }
        }
      },
      pointerEnter: function (type) {
        pointerType = type || "mouse";
        pointerOnFace = true;
        if (!grabbing && settled === "smile" && display === "smile") {
          restSince = clock();
        }
      },
      pointerLeave: function () {
        pointerOnFace = false;
        restSince = 0;
        if (!grabbing && settled === "curious" && display === "curious") {
          settled = "smile";
          display = "smile";
        }
      },
      pointerMove: function (plateX, plateY) {
        pointerPlateX = plateX;
        pointerPlateY = plateY;
        pointerMoving = true;
        lastMoveAt = clock();
        forwardHoldUntil = lastMoveAt + 250 + rand() * 200;
      },
      pointerStopCheck: function (t) {
        if (pointerMoving && t - lastMoveAt > 40) {
          pointerMoving = false;
        }
      },
      pointerDown: function (type) {
        pointerType = type || "mouse";
        grabbing = true;
        cancelled = false;
        restSince = 0;
        if (pull <= PULL_PAIN) {
          settled = "curious";
          display = "curious";
        }
      },
      pointerUp: function (releasePull) {
        var t = clock();
        releaseFace(t, releasePull);
      },
      pointerCancel: function () {
        cancelled = true;
        grabbing = false;
        springHome = true;
        springStart = clock();
      },
      setPull: function (p) {
        pull = p;
        if (grabbing) {
          if (p > PULL_PAIN) {
            settled = "pain";
            display = "pain";
          } else {
            settled = "curious";
            display = "curious";
          }
        }
      },
      getPull: function () {
        return pull;
      },
      getSettled: function () {
        return settled;
      },
      getDisplay: function () {
        return display;
      },
      shouldRunGaze: function () {
        return settled === "smile" && display === "smile" && !grabbing;
      },
      updateGaze: function (t) {
        if (!this.shouldRunGaze()) return gazeCell;
        var eyes = manifest.eyes && manifest.eyes.between;
        var bx = eyes ? eyes[0] : 512;
        var by = eyes ? eyes[1] : 390;
        var target;
        if (!pointerMoving && t < forwardHoldUntil) {
          target = manifest.gaze ? manifest.gaze.center : 12;
        } else if (pointerMoving) {
          target = pickGazeCell(manifest, pointerPlateX, pointerPlateY, bx, by);
        } else {
          target = manifest.gaze ? manifest.gaze.center : 12;
        }
        if (target !== gazeCell && t - lastGazeSwap >= GAZE_CUT_MS) {
          gazeCell = target;
          lastGazeSwap = t;
        }
        return gazeCell;
      },
      getNauseaRemaining: function (t) {
        if (display !== "nausea") return 0;
        return Math.max(0, nauseaUntil - t);
      },
      springUsesOvershoot: function () {
        return !reduced && springHome;
      },
      reducedMotion: reduced,
      fadeMs: function (from, to) {
        if (from === "smile" && to === "curious" && !grabbing && pointerOnFace) {
          return HOVER_CURIOUS_MS;
        }
        if (grabbing) return GRAB_FADE_MS;
        if (to === "smile") return SMILE_RETURN_MS;
        return GRAB_FADE_MS;
      },
      startKeyboardTug: function () {
        keyboardTugActive = true;
        keyboardTugStep = 0;
        settled = "curious";
        display = "curious";
        grabbing = true;
        pull = 0.2;
        settled = "pain";
        display = "pain";
        var t = clock();
        startNausea(t, 500 + 0.2 * 2200);
        keyboardTugStep = 3;
        keyboardTugActive = false;
        grabbing = false;
        springHome = true;
        springStart = t;
        return true;
      },
      isGrabbing: function () {
        return grabbing;
      },
      getPointer: function () {
        return {
          x: pointerPlateX,
          y: pointerPlateY,
          onFace: pointerOnFace,
          type: pointerType,
        };
      },
    };
  }

  function selectRenderPath(canvas) {
    if (!canvas || !canvas.getContext) return "img";
    var gl = null;
    try {
      gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true });
    } catch (_) {}
    if (gl) return "webgl";
    var ctx2d = null;
    try {
      ctx2d = canvas.getContext("2d");
    } catch (_2) {}
    if (ctx2d) return "2d";
    return "img";
  }

  function headOutside(px, py) {
    if (py >= NECK_Y) return true;
    var nx = (px - HEAD_CX) / HEAD_RX;
    var ny = (py - HEAD_CY) / HEAD_RY;
    return nx * nx + ny * ny >= 1;
  }

  // Distance in plate pixels to the nearer of the ellipse edge and the neck.
  // Zero outside the head. Used to fade motion so the head does not tear.
  function headGap(px, py) {
    if (py >= NECK_Y) return 0;
    var dx = px - HEAD_CX;
    var dy = py - HEAD_CY;
    var er = Math.hypot(dx / HEAD_RX, dy / HEAD_RY);
    if (!(er < 1)) return 0;
    var dist = Math.hypot(dx, dy);
    var along = er > 1e-4 ? (dist * (1 - er)) / er : Math.min(HEAD_RX, HEAD_RY);
    var neck = NECK_Y - py;
    return along < neck ? along : neck;
  }

  function headWeight(px, py) {
    var gap = headGap(px, py);
    var band = HEAD_FALLOFF * PLATE;
    if (gap >= band) return 1;
    if (!(gap > 0)) return 0;
    var u = gap / band;
    return u * u * (3 - 2 * u);
  }

  // 0 at the neck, 1 at the crown, so a tug pivots about the base of the neck.
  function neckLever(py) {
    var span = NECK_Y - (HEAD_CY - HEAD_RY);
    if (!(span > 0)) return 0;
    var t = (NECK_Y - py) / span;
    if (t < 0) return 0;
    if (t > 1) return 1;
    return t;
  }

  function headShiftAim(pullX, pullY) {
    var mag = Math.hypot(pullX || 0, pullY || 0);
    if (!(mag > 0.001)) return { x: 0, y: 0 };
    var amp = Math.min(HEAD_SHIFT_CAP * PLATE, HEAD_SHIFT_GAIN * mag);
    return { x: (pullX / mag) * amp, y: (pullY / mag) * amp };
  }

  function makeSpringState(reduced) {
    var rn = Math.floor(PLATE / GRID) + 1;
    var rc = rn - 1;
    var verts = [];
    for (var y = 0; y < rn; y++) {
      for (var x = 0; x < rn; x++) {
        var ox = (x / rc) * PLATE;
        var oy = (y / rc) * PLATE;
        verts.push({ ox: ox, oy: oy, x: ox, y: oy, vx: 0, vy: 0 });
      }
    }
    var cells = SHEET_CELLS;
    var n = cells + 1;
    var count = n * n;
    var fixed = new Uint8Array(count);
    for (var j = 0; j < n; j++) {
      for (var i = 0; i < n; i++) {
        var border = i === 0 || j === 0 || i === cells || j === cells;
        var px = (i / cells) * PLATE;
        var py = (j / cells) * PLATE;
        fixed[j * n + i] = border || headOutside(px, py) ? 1 : 0;
      }
    }
    return {
      verts: verts,
      n: n,
      cells: cells,
      ux: new Float32Array(count),
      uy: new Float32Array(count),
      vx: new Float32Array(count),
      vy: new Float32Array(count),
      ax: new Float32Array(count),
      ay: new Float32Array(count),
      fixed: fixed,
      grabbing: false,
      grabX: 0,
      grabY: 0,
      home: true,
      homeStart: 0,
      reduced: reduced,
      overshoot: !reduced,
      shiftX: 0,
      shiftY: 0,
      shiftVx: 0,
      shiftVy: 0,
      handX: 0,
      handY: 0,
      handReady: false,
      pullX: 0,
      pullY: 0,
      _moving: 0,
      _displaced: 0,
      _far: 0,
    };
  }

  /**
   * Compress pointer travel. At and under 0.6 of the plate, travel is unchanged.
   * Past that knee, extra travel adds progressively less displacement.
   */
  function rubberBand(travel, plateWidth) {
    var sign = travel < 0 ? -1 : 1;
    var t = Math.abs(travel);
    var width = plateWidth || PLATE;
    var knee = RUBBER_KNEE * width;
    if (t <= knee) return sign * t;
    var extra = t - knee;
    var compressed = (0.35 * extra) / (1 + extra / (0.18 * width));
    return sign * (knee + compressed);
  }

  function plateToCell(px, py, cells) {
    return { x: (px / PLATE) * cells, y: (py / PLATE) * cells };
  }

  function bandedHand(grabX, grabY, pointerX, pointerY) {
    var dx = pointerX - grabX;
    var dy = pointerY - grabY;
    var travel = Math.hypot(dx, dy);
    if (!(travel > 0)) return { x: grabX, y: grabY };
    var scale = rubberBand(travel, PLATE) / travel;
    return { x: grabX + dx * scale, y: grabY + dy * scale };
  }

  function sheetParams(cells, reduced) {
    var hz = reduced ? 6 : SHEET_HZ;
    var damp = reduced ? 1 : SHEET_DAMP;
    var w = 2 * Math.PI * hz;
    var c = SHEET_REACH * cells * w;
    return {
      w2: w * w,
      c2: c * c,
      gamma: 2 * damp * w,
      nu: SHEET_FLESH * c,
      limit: RUBBER_KNEE * cells * (RUBBER_KNEE * cells),
    };
  }

  function sheetSettle(spring) {
    spring.ux.fill(0);
    spring.uy.fill(0);
    spring.vx.fill(0);
    spring.vy.fill(0);
    spring.ax.fill(0);
    spring.ay.fill(0);
    spring._moving = 0;
    spring._displaced = 0;
    spring._far = 0;
  }

  function sheetAccelerate(spring, p) {
    var n = spring.n;
    var cells = spring.cells;
    var ux = spring.ux;
    var uy = spring.uy;
    var vx = spring.vx;
    var vy = spring.vy;
    var ax = spring.ax;
    var ay = spring.ay;
    var fixed = spring.fixed;
    var c2 = p.c2;
    var w2 = p.w2;
    var gamma = p.gamma;
    var nu = p.nu;
    var limit = p.limit;
    for (var j = 1; j < cells; j++) {
      var row = j * n;
      for (var i = 1; i < cells; i++) {
        var k = row + i;
        if (fixed[k]) continue;
        var x = ux[k];
        var y = uy[k];
        var vxk = vx[k];
        var vyk = vy[k];
        var hard = w2 * Math.min(SHEET_HARDEST, 1 + (x * x + y * y) / limit);
        ax[k] =
          c2 * (ux[k - 1] + ux[k + 1] + ux[k - n] + ux[k + n] - 4 * x) -
          hard * x -
          gamma * vxk +
          nu * (vx[k - 1] + vx[k + 1] + vx[k - n] + vx[k + n] - 4 * vxk);
        ay[k] =
          c2 * (uy[k - 1] + uy[k + 1] + uy[k - n] + uy[k + n] - 4 * y) -
          hard * y -
          gamma * vyk +
          nu * (vy[k - 1] + vy[k + 1] + vy[k - n] + vy[k + n] - 4 * vyk);
      }
    }
  }

  // Skin currently under the brush takes on the hand's velocity.
  // grip is how fast that happens, per second.
  function sheetBrush(spring, hx, hy, hvx, hvy, radius, grip, dt) {
    if (!(grip > 0) || !(radius > 0)) return;
    var n = spring.n;
    var cells = spring.cells;
    var ux = spring.ux;
    var uy = spring.uy;
    var vx = spring.vx;
    var vy = spring.vy;
    var fixed = spring.fixed;
    var r2 = radius * radius;
    for (var j = 1; j < cells; j++) {
      var row = j * n;
      for (var i = 1; i < cells; i++) {
        var k = row + i;
        if (fixed[k]) continue;
        var dx = i + ux[k] - hx;
        var dy = j + uy[k] - hy;
        var d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        var q = 1 - d2 / r2;
        var hold = q * q * 2.4;
        if (hold > 1) hold = 1;
        var blend = 1 - Math.exp(-grip * hold * dt);
        vx[k] += (hvx - vx[k]) * blend;
        vy[k] += (hvy - vy[k]) * blend;
      }
    }
  }

  function sheetIntegrate(spring, p, dt, hx, hy, hvx, hvy, radius, grip) {
    sheetAccelerate(spring, p);
    var count = spring.n * spring.n;
    var ux = spring.ux;
    var uy = spring.uy;
    var vx = spring.vx;
    var vy = spring.vy;
    var ax = spring.ax;
    var ay = spring.ay;
    var fixed = spring.fixed;
    var i;
    for (i = 0; i < count; i++) {
      if (fixed[i]) continue;
      vx[i] += ax[i] * dt;
      vy[i] += ay[i] * dt;
    }
    if (grip > 0) sheetBrush(spring, hx, hy, hvx, hvy, radius, grip, dt);
    var moving = 0;
    var displaced = 0;
    var far = 0;
    for (i = 0; i < count; i++) {
      if (fixed[i]) {
        ux[i] = 0;
        uy[i] = 0;
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      ux[i] += vx[i] * dt;
      uy[i] += vy[i] * dt;
      moving += vx[i] * vx[i] + vy[i] * vy[i];
      var m = ux[i] * ux[i] + uy[i] * uy[i];
      displaced += m * 40;
      if (m > far) far = m;
    }
    spring._moving = moving;
    spring._displaced = displaced;
    spring._far = far;
  }

  function sheetSimulate(spring, elapsed, fromX, fromY, toX, toY, hvx, hvy, radius, grip) {
    var p = sheetParams(spring.cells, !!spring.reduced);
    var K = 8 * p.c2 + SHEET_HARDEST * p.w2;
    var damp = p.gamma + 8 * p.nu;
    var stable = (0.8 * (Math.sqrt(damp * damp + 4 * K) - damp)) / K;
    var reach = 0;
    if (grip > 0 && radius > 0) {
      reach = Math.ceil(Math.hypot(toX - fromX, toY - fromY) / (radius * 0.5));
    }
    var steps = Math.ceil(elapsed / stable);
    if (steps < 2) steps = 2;
    if (reach > steps) steps = reach;
    if (steps > SHEET_MAX_STEPS) steps = SHEET_MAX_STEPS;
    var dt = elapsed / steps;
    if (dt > stable) dt = stable;
    var slowed = elapsed / (steps * dt);
    var sx = hvx * slowed;
    var sy = hvy * slowed;
    for (var s = 1; s <= steps; s++) {
      var f = s / steps;
      sheetIntegrate(
        spring,
        p,
        dt,
        fromX + (toX - fromX) * f,
        fromY + (toY - fromY) * f,
        sx,
        sy,
        radius,
        grip,
      );
    }
    if (!isFinite(spring._moving + spring._displaced + spring._far)) sheetSettle(spring);
  }

  function syncSheet(spring) {
    var sn = spring.n;
    var sc = spring.cells;
    var scale = PLATE / sc;
    var ux = spring.ux;
    var uy = spring.uy;
    var verts = spring.verts;
    var rn = Math.round(Math.sqrt(verts.length));
    var rc = rn - 1;
    for (var j = 0; j < rn; j++) {
      var gy = (j / rc) * sc;
      var j0 = gy < 0 ? 0 : gy > sc - 1 ? sc - 1 : gy | 0;
      var fy = gy - j0;
      if (fy < 0) fy = 0;
      if (fy > 1) fy = 1;
      var row0 = j0 * sn;
      var row1 = row0 + sn;
      for (var i = 0; i < rn; i++) {
        var gx = (i / rc) * sc;
        var i0 = gx < 0 ? 0 : gx > sc - 1 ? sc - 1 : gx | 0;
        var fx = gx - i0;
        if (fx < 0) fx = 0;
        if (fx > 1) fx = 1;
        var a = row0 + i0;
        var w00 = (1 - fx) * (1 - fy);
        var w10 = fx * (1 - fy);
        var w01 = (1 - fx) * fy;
        var w11 = fx * fy;
        var v = verts[j * rn + i];
        var mx =
          (ux[a] * w00 +
            ux[a + 1] * w10 +
            ux[row1 + i0] * w01 +
            ux[row1 + i0 + 1] * w11) *
          scale;
        var my =
          (uy[a] * w00 +
            uy[a + 1] * w10 +
            uy[row1 + i0] * w01 +
            uy[row1 + i0 + 1] * w11) *
          scale;
        var hw = headWeight(v.ox, v.oy);
        var turn = hw * neckLever(v.oy);
        v.x = v.ox + mx * hw + (spring.shiftX || 0) * turn;
        v.y = v.oy + my * hw + (spring.shiftY || 0) * turn;
      }
    }
  }

  function springAxis(p, v, dt, wd, sigma) {
    var A = p;
    var B = (v + sigma * p) / wd;
    var e = Math.exp(-sigma * dt);
    var c = Math.cos(wd * dt);
    var s = Math.sin(wd * dt);
    var p1 = e * (A * c + B * s);
    var v1 = -sigma * p1 + e * wd * (-A * s + B * c);
    return { p: p1, v: v1 };
  }

  /**
   * Integrate every vertex toward ox/oy.
   * Full motion overshoots to about 1.15 of the remaining distance, then settles
   * inside 700ms. Reduced motion eases over 200ms and stays on the home side.
   */
  function springStep(vertices, dtMs, reduced) {
    if (!vertices || !(dtMs > 0)) return;
    var i;
    var v;
    if (reduced) {
      for (i = 0; i < vertices.length; i++) {
        v = vertices[i];
        if (v._easeFromX == null || v._easeFromY == null) {
          v._easeFromX = v.x;
          v._easeFromY = v.y;
          v._easeT = 0;
        }
        v._easeT += dtMs;
        var u = v._easeT / SPRING_REDUCE_MS;
        if (u < 0) u = 0;
        if (u > 1) u = 1;
        var s = u * u * (3 - 2 * u);
        v.x = v._easeFromX + (v.ox - v._easeFromX) * s;
        v.y = v._easeFromY + (v.oy - v._easeFromY) * s;
        v.vx = 0;
        v.vy = 0;
        if (u >= 1) {
          v.x = v.ox;
          v.y = v.oy;
          v._easeFromX = null;
          v._easeFromY = null;
          v._easeT = 0;
        }
      }
      return;
    }
    var wd = SPRING_WN * Math.sqrt(1 - SPRING_ZETA * SPRING_ZETA);
    var sigma = SPRING_ZETA * SPRING_WN;
    var dt = dtMs / 1000;
    for (i = 0; i < vertices.length; i++) {
      v = vertices[i];
      v._easeFromX = null;
      v._easeFromY = null;
      var px = springAxis(v.x - v.ox, v.vx || 0, dt, wd, sigma);
      var py = springAxis(v.y - v.oy, v.vy || 0, dt, wd, sigma);
      if (Math.abs(px.p) < 0.25 && Math.abs(px.v) < 2) {
        v.x = v.ox;
        v.vx = 0;
      } else {
        v.x = v.ox + px.p;
        v.vx = px.v;
      }
      if (Math.abs(py.p) < 0.25 && Math.abs(py.v) < 2) {
        v.y = v.oy;
        v.vy = 0;
      } else {
        v.y = v.oy + py.p;
        v.vy = py.v;
      }
    }
  }

  function dampShift(p, v, target, dt, wn, zeta) {
    if (!(dt > 0) || !(wn > 0)) return { p: p, v: v };
    if (zeta >= 1) {
      var A = p - target;
      var B = v + wn * A;
      var e = Math.exp(-wn * dt);
      return {
        p: target + (A + B * dt) * e,
        v: (B - wn * (A + B * dt)) * e,
      };
    }
    var wd = wn * Math.sqrt(1 - zeta * zeta);
    var sigma = zeta * wn;
    var off = springAxis(p - target, v, dt, wd, sigma);
    return { p: target + off.p, v: off.v };
  }

  // Rigid lean of the whole head. While grabbed it follows the pull without
  // overshooting the aim. On release it uses the skin's overshoot rule.
  // Reduced motion is critically damped and stays on the home side of the aim.
  function stepHeadShift(spring, dt) {
    var targetX = 0;
    var targetY = 0;
    if (spring.grabbing) {
      var aim = headShiftAim(spring.pullX, spring.pullY);
      targetX = aim.x;
      targetY = aim.y;
    }
    var wn = spring.reduced ? 2 * Math.PI * 6 : SPRING_WN;
    var zeta = spring.reduced || spring.grabbing ? 1 : SPRING_ZETA;
    var sx = dampShift(spring.shiftX || 0, spring.shiftVx || 0, targetX, dt, wn, zeta);
    var sy = dampShift(spring.shiftY || 0, spring.shiftVy || 0, targetY, dt, wn, zeta);
    spring.shiftX = sx.p;
    spring.shiftY = sy.p;
    spring.shiftVx = sx.v;
    spring.shiftVy = sy.v;
    if (!isFinite(spring.shiftX + spring.shiftY + spring.shiftVx + spring.shiftVy)) {
      spring.shiftX = 0;
      spring.shiftY = 0;
      spring.shiftVx = 0;
      spring.shiftVy = 0;
      return;
    }
    if (
      !spring.grabbing &&
      Math.hypot(spring.shiftX, spring.shiftY) < 0.25 &&
      Math.hypot(spring.shiftVx, spring.shiftVy) < 2
    ) {
      spring.shiftX = 0;
      spring.shiftY = 0;
      spring.shiftVx = 0;
      spring.shiftVy = 0;
    }
  }

  function stepMesh(spring, engine, dtMs) {
    if (!spring || !engine || !spring.ux) return;
    var elapsed = dtMs > 0 ? dtMs / 1000 : 0.016;
    if (elapsed < 0.001) elapsed = 0.001;
    if (elapsed > 0.05) elapsed = 0.05;
    var ptr = engine.getPointer
      ? engine.getPointer()
      : { x: PLATE / 2, y: PLATE / 2, onFace: false, type: "mouse" };
    var grabbing = !!(engine.isGrabbing && engine.isGrabbing());
    var cells = spring.cells;
    var toX;
    var toY;
    var hvx = 0;
    var hvy = 0;
    var radius = 0;
    var grip = 0;

    if (grabbing) {
      if (!spring.grabbing) {
        var gx = engine._grabPlateX;
        var gy = engine._grabPlateY;
        if (gx == null) gx = ptr.x;
        if (gy == null) gy = ptr.y;
        spring.grabbing = true;
        spring.home = false;
        spring.grabX = gx;
        spring.grabY = gy;
        var origin = plateToCell(gx, gy, cells);
        spring.handX = origin.x;
        spring.handY = origin.y;
        spring.handReady = true;
      }
      var hand = bandedHand(spring.grabX, spring.grabY, ptr.x, ptr.y);
      var hc = plateToCell(hand.x, hand.y, cells);
      toX = hc.x;
      toY = hc.y;
      hvx = (toX - spring.handX) / elapsed;
      hvy = (toY - spring.handY) / elapsed;
      radius = Math.max(1.8, SHEET_HANDFUL * cells);
      grip = SHEET_GRIP;
      var grabbed = plateToCell(spring.grabX, spring.grabY, cells);
      var scale = PLATE / cells;
      spring.pullX = (toX - grabbed.x) * scale;
      spring.pullY = (toY - grabbed.y) * scale;
    } else {
      if (spring.grabbing) {
        spring.grabbing = false;
        spring.home = true;
      }
      var pc = plateToCell(ptr.x, ptr.y, cells);
      toX = pc.x;
      toY = pc.y;
      if (!spring.handReady) {
        spring.handX = toX;
        spring.handY = toY;
        spring.handReady = true;
      }
    }

    stepHeadShift(spring, elapsed);
    if (grabbing && grip > 0) {
      var grabW = headWeight(spring.grabX, spring.grabY);
      var grabTurn = grabW * neckLever(spring.grabY);
      var cellPx = PLATE / cells;
      toX -= ((spring.shiftX || 0) * grabTurn) / cellPx;
      toY -= ((spring.shiftY || 0) * grabTurn) / cellPx;
      hvx = (toX - spring.handX) / elapsed;
      hvy = (toY - spring.handY) / elapsed;
    }

    var fromX = spring.handX;
    var fromY = spring.handY;
    sheetSimulate(spring, elapsed, fromX, fromY, toX, toY, hvx, hvy, radius, grip);
    spring.handX = toX;
    spring.handY = toY;
    var homeCell = 0.35 * cells / PLATE;
    if (!grabbing && !(grip > 0) && spring._far < homeCell * homeCell && spring._moving < 0.5) {
      sheetSettle(spring);
    }
    syncSheet(spring);
    spring._dtMs = dtMs > 0 ? dtMs : 0;
  }

  function plateClipX(px) {
    return -1 + (2 * (PAD_FRAC + px / PLATE)) / (1 + 2 * PAD_FRAC);
  }

  function plateClipY(py) {
    return 1 - (2 * (PAD_FRAC + py / PLATE)) / (1 + 2 * PAD_FRAC);
  }

  function createPlateFade() {
    var fade = { from: null, to: null, start: 0, ms: 0 };
    return {
      sample: function (plateKey, engine, now) {
        var t = now || 0;
        if (fade.to === null) {
          fade.from = plateKey;
          fade.to = plateKey;
          fade.start = t;
          fade.ms = 0;
        } else if (plateKey !== fade.to) {
          fade.from = fade.to;
          fade.to = plateKey;
          fade.start = t;
          fade.ms =
            engine && engine.fadeMs ? engine.fadeMs(fade.from, plateKey) : GRAB_FADE_MS;
        }
        var mix = 1;
        if (fade.ms > 0) {
          mix = (t - fade.start) / fade.ms;
          if (mix < 0) mix = 0;
          if (mix > 1) mix = 1;
        }
        return { from: fade.from, to: fade.to, mix: mix };
      },
    };
  }

  function gazeReady(engine, fade) {
    if (!engine || !engine.shouldRunGaze || !engine.shouldRunGaze()) return false;
    if (!fade || fade.to !== "smile" || fade.mix < 1) return false;
    return true;
  }

  function gazeBlits(manifest, cell) {
    var g = manifest && manifest.gaze;
    var eyes = manifest && manifest.eyes;
    if (!g || !eyes || !eyes.left || !eyes.right) return null;
    var cw = g.cellWidth;
    var ch = g.cellHeight;
    var sx = cell * cw;
    return {
      left: {
        sx: sx,
        sy: 0,
        sw: eyes.left[2],
        sh: ch,
        dx: eyes.left[0],
        dy: eyes.left[1],
      },
      right: {
        sx: sx + eyes.left[2],
        sy: 0,
        sw: eyes.right[2],
        sh: ch,
        dx: eyes.right[0],
        dy: eyes.right[1],
      },
    };
  }

  function bindPlatePointer(el, engine, stageToPlate) {
    var activeId = null;

    function pullFromEvent(ev) {
      if (!engine.isGrabbing()) return 0;
      var pt = stageToPlate(ev.clientX, ev.clientY);
      var gx = engine._grabPlateX || 512;
      var gy = engine._grabPlateY || 512;
      return Math.min(1, Math.hypot(pt.x - gx, pt.y - gy) / PLATE);
    }

    el.addEventListener(
      "pointerdown",
      function (ev) {
        if (ev.button !== 0 && ev.pointerType === "mouse") return;
        activeId = ev.pointerId;
        el.setPointerCapture(ev.pointerId);
        var pt = stageToPlate(ev.clientX, ev.clientY);
        engine.pointerMove(pt.x, pt.y);
        engine._grabPlateX = pt.x;
        engine._grabPlateY = pt.y;
        engine.pointerDown(ev.pointerType);
        engine.setPull(0);
      },
      { passive: false },
    );

    el.addEventListener("pointermove", function (ev) {
      var pt = stageToPlate(ev.clientX, ev.clientY);
      engine.pointerMove(pt.x, pt.y);
      if (engine.isGrabbing()) {
        engine.setPull(pullFromEvent(ev));
      }
    });

    el.addEventListener("pointerup", function (ev) {
      if (activeId !== ev.pointerId) return;
      activeId = null;
      var p = pullFromEvent(ev);
      engine.pointerUp(p);
    });

    el.addEventListener("pointercancel", function () {
      activeId = null;
      engine.pointerCancel();
    });

    el.addEventListener("pointerenter", function (ev) {
      engine.pointerEnter(ev.pointerType);
    });

    el.addEventListener("pointerleave", function () {
      engine.pointerLeave();
    });
  }

  function mountImages(root, manifest, manifestUrl, onLoad) {
    var smileName =
      (manifest.plates && manifest.plates.smile) || "smile.webp";
    var img = document.createElement("img");
    img.alt = root.getAttribute("alt") || manifest.alt || "";
    img.src = resolveUrl(smileName, manifestUrl);
    img.decoding = "async";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.style.display = "block";
    root.appendChild(img);
    img.addEventListener("load", onLoad);
    return img;
  }

  function loadImageBitmaps(manifest, manifestUrl, fetchFn) {
    var keys = ["smile", "curious", "pain", "nausea"];
    var plates = manifest.plates || {};
    var pending = [];
    var out = {};
    keys.forEach(function (k) {
      if (!plates[k]) return;
      pending.push(
        fetchFn(resolveUrl(plates[k], manifestUrl))
          .then(function (r) {
            return r.blob();
          })
          .then(function (b) {
            return createImageBitmap(b);
          })
          .then(function (bmp) {
            out[k] = bmp;
          })
          .catch(function () {}),
      );
    });
    var gazeP = null;
    if (manifest.gaze && manifest.gaze.sheet) {
      gazeP = fetchFn(resolveUrl(manifest.gaze.sheet, manifestUrl))
        .then(function (r) {
          return r.blob();
        })
        .then(function (b) {
          return createImageBitmap(b);
        })
        .catch(function () {
          return null;
        });
    }
    return Promise.all(pending).then(function () {
      return gazeP.then(function (sheet) {
        out.gazeSheet = sheet;
        return out;
      });
    });
  }

  function createWebGLRenderer(canvas, images, manifest) {
    var gl = canvas.getContext("webgl");
    if (!gl) return null;
    var vs =
      "attribute vec2 a_pos;attribute vec2 a_uv;varying vec2 v_uv;void main(){v_uv=a_uv;gl_Position=vec4(a_pos,0.0,1.0);}";
    var fsMix =
      "precision mediump float;varying vec2 v_uv;uniform sampler2D u_tex0;uniform sampler2D u_tex1;uniform float u_mix;void main(){vec4 a=texture2D(u_tex0,v_uv);vec4 b=texture2D(u_tex1,v_uv);gl_FragColor=mix(a,b,u_mix);}";
    var fsBlit =
      "precision mediump float;varying vec2 v_uv;uniform sampler2D u_tex;void main(){gl_FragColor=texture2D(u_tex,v_uv);}";

    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    }
    function link(fragSrc) {
      var prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc));
      gl.bindAttribLocation(prog, 0, "a_pos");
      gl.bindAttribLocation(prog, 1, "a_uv");
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
      return prog;
    }
    var prog = link(fsMix);
    var blitProg = link(fsBlit);
    if (!prog || !blitProg) return null;

    var uTex0 = gl.getUniformLocation(prog, "u_tex0");
    var uTex1 = gl.getUniformLocation(prog, "u_tex1");
    var uMix = gl.getUniformLocation(prog, "u_mix");
    var uBlit = gl.getUniformLocation(blitProg, "u_tex");

    function makeTex() {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    }
    var tex0 = makeTex();
    var tex1 = makeTex();
    var texGaze = makeTex();
    var uploaded = { a: null, b: null, g: null };

    function upload(tex, bitmap, slot) {
      if (!bitmap || uploaded[slot] === bitmap) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      uploaded[slot] = bitmap;
    }

    var n = Math.floor(PLATE / GRID) + 1;
    var mesh = new Float32Array(n * n * 4);
    var meshBuf = gl.createBuffer();
    var cells = n - 1;
    var indices = new Uint16Array(cells * cells * 6);
    var cursor = 0;
    for (var row = 0; row < cells; row++) {
      for (var col = 0; col < cells; col++) {
        var i0 = row * n + col;
        indices[cursor++] = i0;
        indices[cursor++] = i0 + 1;
        indices[cursor++] = i0 + n;
        indices[cursor++] = i0 + 1;
        indices[cursor++] = i0 + n + 1;
        indices[cursor++] = i0 + n;
      }
    }
    var indexBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    var indexCount = indices.length;
    var gazeBuf = gl.createBuffer();
    var fade = createPlateFade();

    function writeMesh(spring) {
      var verts = spring && spring.verts;
      for (var i = 0; i < n * n; i++) {
        var ox;
        var oy;
        var px;
        var py;
        if (verts && verts[i]) {
          ox = verts[i].ox;
          oy = verts[i].oy;
          px = verts[i].x;
          py = verts[i].y;
        } else {
          var gx = i % n;
          var gy = (i / n) | 0;
          ox = (gx / (n - 1)) * PLATE;
          oy = (gy / (n - 1)) * PLATE;
          px = ox;
          py = oy;
        }
        var o = i * 4;
        mesh[o] = plateClipX(px);
        mesh[o + 1] = plateClipY(py);
        mesh[o + 2] = ox / PLATE;
        mesh[o + 3] = oy / PLATE;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf);
      gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.DYNAMIC_DRAW);
    }

    function bindAttribs() {
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    }

    function drawGaze(engine, now) {
      if (!images.gazeSheet || !manifest) return;
      var cell = engine.updateGaze(now || 0);
      var blits = gazeBlits(manifest, cell);
      if (!blits) return;
      var sheet = images.gazeSheet;
      var sw = sheet.width || 1;
      var sh = sheet.height || 1;
      upload(texGaze, sheet, "g");
      gl.useProgram(blitProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texGaze);
      gl.uniform1i(uBlit, 0);
      var parts = [blits.left, blits.right];
      for (var g = 0; g < parts.length; g++) {
        var b = parts[g];
        var u0 = b.sx / sw;
        var v0 = b.sy / sh;
        var u1 = (b.sx + b.sw) / sw;
        var v1 = (b.sy + b.sh) / sh;
        var x0 = plateClipX(b.dx);
        var x1 = plateClipX(b.dx + b.sw);
        var yTop = plateClipY(b.dy);
        var yBot = plateClipY(b.dy + b.sh);
        gl.bindBuffer(gl.ARRAY_BUFFER, gazeBuf);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([
            x0, yBot, u0, v1, x1, yBot, u1, v1, x0, yTop, u0, v0, x1, yTop, u1, v0,
          ]),
          gl.DYNAMIC_DRAW,
        );
        bindAttribs();
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }

    return {
      kind: "webgl",
      draw: function (plateKey, engine, spring, now, dtMs) {
        var sample = fade.sample(plateKey, engine, now || 0);
        var fromBmp = images[sample.from] || images.smile;
        var toBmp = images[sample.to] || images.smile || fromBmp;
        if (!fromBmp && !toBmp) return;
        if (!fromBmp) fromBmp = toBmp;
        if (!toBmp) toBmp = fromBmp;
        writeMesh(spring);
        upload(tex0, fromBmp, "a");
        upload(tex1, toBmp, "b");
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex0);
        gl.uniform1i(uTex0, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, tex1);
        gl.uniform1i(uTex1, 1);
        gl.uniform1f(uMix, sample.mix);
        gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf);
        bindAttribs();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
        gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
        if (gazeReady(engine, sample)) drawGaze(engine, now || 0);
      },
      lose: function () {
        try {
          var ext = gl.getExtension("WEBGL_lose_context");
          if (ext) ext.loseContext();
        } catch (_) {}
      },
    };
  }

  function create2DRenderer(canvas, ctx, images, manifest) {
    var fade = createPlateFade();

    function vertexAt(spring, plateX, plateY) {
      var verts = spring.verts;
      var n = Math.floor(PLATE / GRID) + 1;
      var gx = Math.round((plateX / PLATE) * (n - 1));
      var gy = Math.round((plateY / PLATE) * (n - 1));
      if (gx < 0) gx = 0;
      if (gy < 0) gy = 0;
      if (gx > n - 1) gx = n - 1;
      if (gy > n - 1) gy = n - 1;
      return verts[gy * n + gx];
    }

    function drawSlices(bmp, spring, photo) {
      if (!bmp) return;
      if (!spring || !spring.verts) {
        ctx.drawImage(bmp, photo.x, photo.y, photo.w, photo.h);
        return;
      }
      var bw = bmp.width || PLATE;
      var bh = bmp.height || PLATE;
      for (var y = 0; y < PLATE; y += COARSE) {
        for (var x = 0; x < PLATE; x += COARSE) {
          var pw = Math.min(COARSE, PLATE - x);
          var ph = Math.min(COARSE, PLATE - y);
          var v = vertexAt(spring, x + pw / 2, y + ph / 2);
          var dx = v ? v.x - v.ox : 0;
          var dy = v ? v.y - v.oy : 0;
          ctx.drawImage(
            bmp,
            (x / PLATE) * bw,
            (y / PLATE) * bh,
            (pw / PLATE) * bw,
            (ph / PLATE) * bh,
            photo.x + photo.w * ((x + dx) / PLATE),
            photo.y + photo.h * ((y + dy) / PLATE),
            photo.w * (pw / PLATE),
            photo.h * (ph / PLATE),
          );
        }
      }
    }

    function drawGaze(engine, photo, now) {
      if (!images.gazeSheet || !manifest || !manifest.gaze) return;
      var cell = engine.updateGaze(now || Date.now());
      var blits = gazeBlits(manifest, cell);
      if (!blits) return;
      var parts = [blits.left, blits.right];
      for (var i = 0; i < parts.length; i++) {
        var b = parts[i];
        ctx.drawImage(
          images.gazeSheet,
          b.sx,
          b.sy,
          b.sw,
          b.sh,
          photo.x + photo.w * (b.dx / PLATE),
          photo.y + photo.h * (b.dy / PLATE),
          photo.w * (b.sw / PLATE),
          photo.h * (b.sh / PLATE),
        );
      }
    }

    return {
      kind: "2d",
      draw: function (plateKey, engine, spring, now) {
        var photo = photoRect(canvas.width, canvas.height);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        var sample = fade.sample(plateKey, engine, now || 0);
        var fromBmp = images[sample.from] || images.smile;
        var toBmp = images[sample.to] || images.smile || fromBmp;
        if (sample.mix >= 1 || sample.mix <= 0) {
          drawSlices(sample.mix <= 0 ? fromBmp : toBmp, spring, photo);
        } else {
          ctx.save();
          ctx.globalAlpha = 1 - sample.mix;
          drawSlices(fromBmp, spring, photo);
          ctx.globalAlpha = sample.mix;
          drawSlices(toBmp, spring, photo);
          ctx.restore();
        }
        if (engine && gazeReady(engine, sample)) drawGaze(engine, photo, now);
      },
    };
  }

  class ExpressionsFace extends HTMLElement {
    constructor() {
      super();
      this._loop = null;
      this._engine = null;
      this._renderer = null;
      this._img = null;
      this._canvas = null;
      this._connected = false;
      this._webglRetries = 0;
      this._manifestUrl = null;
      this._fetchGuard = null;
    }

    connectedCallback() {
      if (this._connected) return;
      this._connected = true;
      var src = this.getAttribute("src");
      if (!src) return;
      this._manifestUrl = src;
      var self = this;
      this.style.display = "block";
      this.style.position = "relative";
      this.style.touchAction = "none";
      this.style.overflow = "hidden";

      var btn = document.createElement("button");
      btn.type = "button";
      btn.style.cssText =
        "display:block;width:100%;height:100%;padding:0;border:0;background:transparent;cursor:grab;position:relative;overflow:hidden;";
      btn.style.aspectRatio = "1";
      self.appendChild(btn);

      fetch(src)
        .then(function (r) {
          return r.json();
        })
        .then(function (manifest) {
          self._img = mountImages(btn, manifest, src, function () {});
          var urls = collectFetchUrls(manifest, src);
          var allowed = allowedOrigins(urls);
          self._fetchGuard = createFetchGuard(allowed);
          var guarded = self._fetchGuard;
          btn.setAttribute(
            "aria-label",
            self.getAttribute("alt") || manifest.alt || "face",
          );

          var reduced =
            global.matchMedia &&
            global.matchMedia("(prefers-reduced-motion: reduce)").matches;

          self._engine = createEngine(manifest, { reducedMotion: reduced });
          self._spring = makeSpringState(reduced);

          return loadImageBitmaps(manifest, src, guarded).then(function (images) {
            self._images = images;
            self._setupStage(btn, manifest, reduced);
          });
        })
        .catch(function () {});

      btn.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          if (self._engine) self._engine.startKeyboardTug();
        }
      });
    }

    _setupStage(btn, manifest, reduced) {
      var pad = PLATE * PAD_FRAC;
      var stage = PLATE + pad * 2;
      var canvas = document.createElement("canvas");
      canvas.width = stage;
      canvas.height = stage;
      canvas.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;max-width:none;";
      btn.appendChild(canvas);
      this._canvas = canvas;

      var path = selectRenderPath(canvas);
      if (path === "img") {
        return;
      }

      if (this._img) {
        this._img.style.visibility = "hidden";
        this._img.classList.add("expressions-face-fallback");
      }

      var self = this;
      if (path === "webgl") {
        this._renderer = createWebGLRenderer(canvas, this._images, manifest);
        if (!this._renderer) {
          path = "2d";
        }
      }
      if (path === "2d") {
        var ctx = canvas.getContext("2d");
        this._renderer = create2DRenderer(canvas, ctx, this._images, manifest);
      }

      function stageToPlate(clientX, clientY) {
        var rect = btn.getBoundingClientRect();
        var photo = photoRect(rect.width, rect.height);
        return {
          x: ((clientX - rect.left - photo.x) / photo.w) * PLATE,
          y: ((clientY - rect.top - photo.y) / photo.h) * PLATE,
        };
      }

      bindPlatePointer(btn, this._engine, stageToPlate);

      var last = performance.now();
      function frame(t) {
        if (!self._connected || document.hidden) return;
        var dtMs = Math.min(50, t - last);
        last = t;
        self._engine.tick(t);
        self._engine.pointerStopCheck(t);
        stepMesh(self._spring, self._engine, dtMs);
        var disp = self._engine.getDisplay();
        if (self._renderer) {
          self._renderer.draw(disp, self._engine, self._spring, t, dtMs);
        }
        self._loop = requestAnimationFrame(frame);
      }

      var onVis = function () {
        if (document.hidden) {
          if (self._loop) cancelAnimationFrame(self._loop);
          self._loop = null;
          if (self._renderer && self._renderer.kind === "webgl") {
            self._renderer.lose();
          }
        } else if (!self._loop && self._connected) {
          if (
            self._renderer &&
            self._renderer.kind === "webgl" &&
            self._webglRetries < 3
          ) {
            self._webglRetries++;
            self._setupStage(btn, manifest, reduced);
            return;
          }
          self._loop = requestAnimationFrame(frame);
        }
      };
      document.addEventListener("visibilitychange", onVis);
      this._loop = requestAnimationFrame(frame);
    }

    disconnectedCallback() {
      this._connected = false;
      if (this._loop) cancelAnimationFrame(this._loop);
      this._loop = null;
      if (this._renderer && this._renderer.kind === "webgl") {
        this._renderer.lose();
      }
    }
  }

  if (!global.customElements.get("expressions-face")) {
    global.customElements.define("expressions-face", ExpressionsFace);
  }

  global.__EXPRESSIONS_FACE__ = {
    PLATE: PLATE,
    PULL_TAP: PULL_TAP,
    PULL_PAIN: PULL_PAIN,
    createEngine: createEngine,
    collectFetchUrls: collectFetchUrls,
    allowedOrigins: allowedOrigins,
    createFetchGuard: createFetchGuard,
    selectRenderPath: selectRenderPath,
    makeSpringState: makeSpringState,
    springUsesOvershoot: function (state) {
      return state.overshoot && state.home && !state.reduced;
    },
    rubberBand: rubberBand,
    springStep: springStep,
    stepMesh: stepMesh,
    resolveUrl: resolveUrl,
    ExpressionsFace: ExpressionsFace,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
