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
  var COARSE = 32;
  var PAD_FRAC = 0.3;
  var GRAB_RADIUS = 0.07;
  var RUBBER_KNEE = 0.6;
  var HOVER_CATCH = 8;
  var LEAN_PX = 6;

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

  function makeSpringState(reduced) {
    var verts = [];
    var n = Math.floor(PLATE / GRID) + 1;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        verts.push({
          ox: (x / (n - 1)) * PLATE,
          oy: (y / (n - 1)) * PLATE,
          x: (x / (n - 1)) * PLATE,
          y: (y / (n - 1)) * PLATE,
          vx: 0,
          vy: 0,
        });
      }
    }
    return {
      verts: verts,
      grabbing: false,
      grabX: 0,
      grabY: 0,
      home: true,
      homeStart: 0,
      reduced: reduced,
      overshoot: !reduced,
      leanX: 0,
      leanY: 0,
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

  /**
   * Offset that pulls a plate-space vertex toward the pointer.
   * A vertex on the grab point follows the rubber-banded pointer.
   * Past ~7% of the plate width the offset is zero.
   */
  function grabOffset(vertex, grabPoint, pointer, plateWidth) {
    var width = plateWidth || PLATE;
    var vx = vertex.x;
    var vy = vertex.y;
    if (vx == null) vx = vertex.ox;
    if (vy == null) vy = vertex.oy;
    var dist = Math.hypot(vx - grabPoint.x, vy - grabPoint.y);
    var radius = GRAB_RADIUS * width;
    if (!(dist < radius)) return { x: 0, y: 0 };
    var travelX = pointer.x - grabPoint.x;
    var travelY = pointer.y - grabPoint.y;
    var travel = Math.hypot(travelX, travelY);
    if (!(travel > 0)) return { x: 0, y: 0 };
    var banded = rubberBand(travel, width);
    var scale = banded / travel;
    var falloff = 0.5 * (1 + Math.cos(Math.PI * (dist / radius)));
    return { x: travelX * scale * falloff, y: travelY * scale * falloff };
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

  function clearEase(verts) {
    for (var i = 0; i < verts.length; i++) {
      verts[i]._easeFromX = null;
      verts[i]._easeFromY = null;
      verts[i]._easeT = 0;
    }
  }

  function beginGrab(spring, x, y) {
    spring.grabbing = true;
    spring.home = false;
    spring.hoverLive = false;
    spring.grabX = x;
    spring.grabY = y;
    spring.hx = 0;
    spring.hy = 0;
    spring.prevPtr = null;
    var verts = spring.verts;
    var best = 0;
    var bestD = Infinity;
    for (var i = 0; i < verts.length; i++) {
      var v = verts[i];
      v.bx = v.x;
      v.by = v.y;
      v.vx = 0;
      v.vy = 0;
      v._easeFromX = null;
      v._easeFromY = null;
      v._easeT = 0;
      var d = (v.ox - x) * (v.ox - x) + (v.oy - y) * (v.oy - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    spring.pinIndex = best;
  }

  function applyGrab(spring, ptr) {
    var grab = { x: spring.grabX, y: spring.grabY };
    var pointer = { x: ptr.x, y: ptr.y };
    var verts = spring.verts;
    var pin = spring.pinIndex;
    for (var i = 0; i < verts.length; i++) {
      var v = verts[i];
      var sample = i === pin ? grab : { x: v.ox, y: v.oy };
      var off = grabOffset(sample, grab, pointer, PLATE);
      v.x = v.bx + off.x;
      v.y = v.by + off.y;
      v.vx = 0;
      v.vy = 0;
    }
    var full = grabOffset(grab, grab, pointer, PLATE);
    spring.pullX = full.x;
    spring.pullY = full.y;
  }

  function applyHover(spring, ptr, dtMs) {
    var prev = spring.prevPtr;
    var dx = 0;
    var dy = 0;
    if (prev) {
      dx = ptr.x - prev.x;
      dy = ptr.y - prev.y;
    }
    spring.prevPtr = { x: ptr.x, y: ptr.y };
    var decay = Math.exp(-(dtMs > 0 ? dtMs : 0) / 110);
    var hx = (spring.hx || 0) * decay + dx * 0.85;
    var hy = (spring.hy || 0) * decay + dy * 0.85;
    var mag = Math.hypot(hx, hy);
    if (mag > HOVER_CATCH) {
      hx = (hx / mag) * HOVER_CATCH;
      hy = (hy / mag) * HOVER_CATCH;
    }
    spring.hx = hx;
    spring.hy = hy;
    var grab = { x: ptr.x, y: ptr.y };
    var nudged = { x: ptr.x + hx, y: ptr.y + hy };
    var verts = spring.verts;
    for (var i = 0; i < verts.length; i++) {
      var v = verts[i];
      var off = grabOffset({ x: v.ox, y: v.oy }, grab, nudged, PLATE);
      v.x = v.ox + off.x;
      v.y = v.oy + off.y;
      v.vx = 0;
      v.vy = 0;
      v._easeFromX = null;
      v._easeFromY = null;
    }
  }

  function meshCalm(verts) {
    for (var i = 0; i < verts.length; i++) {
      var v = verts[i];
      if (Math.hypot(v.x - v.ox, v.y - v.oy) > 0.6) return false;
      if (Math.hypot(v.vx || 0, v.vy || 0) > 12) return false;
    }
    return true;
  }

  function stepMesh(spring, engine, dtMs) {
    if (!spring || !engine || !spring.verts) return;
    var dt = dtMs > 0 ? dtMs : 0;
    var ptr = engine.getPointer
      ? engine.getPointer()
      : { x: PLATE / 2, y: PLATE / 2, onFace: false, type: "mouse" };
    var grabbing = !!(engine.isGrabbing && engine.isGrabbing());
    if (grabbing) {
      if (!spring.grabbing) {
        var gx = engine._grabPlateX;
        var gy = engine._grabPlateY;
        if (gx == null) gx = ptr.x;
        if (gy == null) gy = ptr.y;
        beginGrab(spring, gx, gy);
      }
      applyGrab(spring, ptr);
      spring.hoverLive = false;
    } else {
      if (spring.grabbing) {
        spring.grabbing = false;
        spring.home = true;
        spring.hoverLive = false;
        spring.prevPtr = null;
        spring.hx = 0;
        spring.hy = 0;
        clearEase(spring.verts);
      }
      var canHover =
        ptr.onFace &&
        ptr.type !== "touch" &&
        (spring.hoverLive || meshCalm(spring.verts));
      if (canHover) {
        spring.hoverLive = true;
        applyHover(spring, ptr, dt);
      } else {
        spring.hoverLive = false;
        spring.prevPtr = null;
        spring.hx = 0;
        spring.hy = 0;
        springStep(spring.verts, dt, !!spring.reduced);
      }
    }
    spring._dtMs = dt;
  }

  function updateLean(spring, dtMs) {
    if (!spring) return;
    var targetX = 0;
    var targetY = 0;
    if (spring.grabbing) {
      var px = spring.pullX || 0;
      var py = spring.pullY || 0;
      var mag = Math.hypot(px, py);
      if (mag > 0.001) {
        var gain = Math.min(1, mag / (PLATE * 0.2));
        targetX = (px / mag) * LEAN_PX * gain;
        targetY = (py / mag) * LEAN_PX * gain;
      }
    }
    var k = 1 - Math.exp(-(dtMs > 0 ? dtMs : 0) / 240);
    var lx = spring.leanX || 0;
    var ly = spring.leanY || 0;
    spring.leanX = lx + (targetX - lx) * k;
    spring.leanY = ly + (targetY - ly) * k;
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
      var leanX = spring && spring.leanX ? spring.leanX : 0;
      var leanY = spring && spring.leanY ? spring.leanY : 0;
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
        var neck = 1 - oy / PLATE;
        var o = i * 4;
        mesh[o] = plateClipX(px + leanX * neck);
        mesh[o + 1] = plateClipY(py + leanY * neck);
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
        if (spring) updateLean(spring, dtMs != null ? dtMs : spring._dtMs || 0);
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
    grabOffset: grabOffset,
    springStep: springStep,
    resolveUrl: resolveUrl,
    ExpressionsFace: ExpressionsFace,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
