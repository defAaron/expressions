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
  var GRID = 10;
  var PAD_FRAC = 0.3;
  var GRAB_RADIUS = 0.07;

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
    };
  }

  function springTick(state, dt, t) {
    if (!state.home && !state.grabbing) return;
    var stiffness = state.reduced ? 0.35 : 0.18;
    var damp = state.reduced ? 0.92 : 0.82;
    var overshoot = state.overshoot && !state.reduced;
    for (var i = 0; i < state.verts.length; i++) {
      var v = state.verts[i];
      if (state.grabbing) continue;
      var dx = v.ox - v.x;
      var dy = v.oy - v.y;
      if (state.reduced && state.home) {
        var alpha = Math.min(1, (t - state.homeStart) / SPRING_REDUCE_MS);
        v.x = v.ox * alpha + v.x * (1 - alpha);
        v.y = v.oy * alpha + v.y * (1 - alpha);
        continue;
      }
      v.vx += dx * stiffness;
      v.vy += dy * stiffness;
      if (overshoot && Math.hypot(dx, dy) > 1) {
        v.vx += dx * 0.03;
        v.vy += dy * 0.03;
      }
      v.vx *= damp;
      v.vy *= damp;
      v.x += v.vx * dt;
      v.y += v.vy * dt;
    }
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

  function createWebGLRenderer(canvas, images) {
    var gl = canvas.getContext("webgl");
    if (!gl) return null;
    var vs =
      "attribute vec2 a_pos;attribute vec2 a_uv;varying vec2 v_uv;void main(){v_uv=a_uv;gl_Position=vec4(a_pos,0.,1.);}";
    var fs =
      "precision mediump float;varying vec2 v_uv;uniform sampler2D u_tex;void main(){gl_FragColor=texture2D(u_tex,v_uv);}";
    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    function upload(bitmap) {
      if (!bitmap) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    }

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]),
      gl.STATIC_DRAW,
    );

    return {
      kind: "webgl",
      draw: function (plateKey) {
        var bmp = images[plateKey] || images.smile;
        upload(bmp);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog);
        var loc = gl.getAttribLocation(prog, "a_pos");
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 16, 0);
        var locUv = gl.getAttribLocation(prog, "a_uv");
        gl.enableVertexAttribArray(locUv);
        gl.vertexAttribPointer(locUv, 2, gl.FLOAT, false, 16, 8);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
    return {
      kind: "2d",
      draw: function (plateKey, engine) {
        var bmp = images[plateKey] || images.smile;
        if (!bmp) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        if (engine.shouldRunGaze() && images.gazeSheet && manifest.gaze) {
          var cell = engine.updateGaze(Date.now());
          var cw = manifest.gaze.cellWidth;
          var ch = manifest.gaze.cellHeight;
          var sx = cell * cw;
          var eyes = manifest.eyes;
          if (eyes) {
            ctx.drawImage(
              images.gazeSheet,
              sx,
              0,
              eyes.left[2],
              ch,
              0,
              0,
              canvas.width * (eyes.left[2] / PLATE),
              canvas.height * (ch / PLATE),
            );
            ctx.drawImage(
              images.gazeSheet,
              sx + eyes.left[2],
              0,
              eyes.right[2],
              ch,
              canvas.width * (eyes.right[0] / PLATE),
              canvas.height * (eyes.right[1] / PLATE),
              canvas.width * (eyes.right[2] / PLATE),
              canvas.height * (ch / PLATE),
            );
          }
        }
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

      var btn = document.createElement("button");
      btn.type = "button";
      btn.style.cssText =
        "display:block;width:100%;height:100%;padding:0;border:0;background:transparent;cursor:grab;position:relative;";
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
        "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:calc(100% + " +
        (PAD_FRAC * 200) +
        "%);height:auto;max-width:none;";
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
        this._renderer = createWebGLRenderer(canvas, this._images);
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
        var nx = (clientX - rect.left) / rect.width;
        var ny = (clientY - rect.top) / rect.height;
        return {
          x: nx * PLATE,
          y: ny * PLATE,
        };
      }

      bindPlatePointer(btn, this._engine, stageToPlate);

      var last = performance.now();
      function frame(t) {
        if (!self._connected || document.hidden) return;
        var dt = Math.min(0.05, (t - last) / 1000);
        last = t;
        self._engine.tick(t);
        self._engine.pointerStopCheck(t);
        var disp = self._engine.getDisplay();
        if (self._renderer) {
          if (self._renderer.kind === "2d") {
            self._renderer.draw(disp, self._engine);
          } else {
            self._renderer.draw(disp);
          }
        }
        springTick(self._spring, dt, t);
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
    resolveUrl: resolveUrl,
    ExpressionsFace: ExpressionsFace,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
