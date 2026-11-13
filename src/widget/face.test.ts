import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const MANIFEST = {
  version: 1,
  size: [1024, 1024],
  alt: "Test face",
  eyes: {
    left: [310, 340, 150, 110],
    right: [560, 338, 148, 110],
    between: [512, 390],
  },
  plates: {
    smile: "smile.webp",
    curious: "curious.webp",
    pain: "pain.webp",
    nausea: "nausea.webp",
  },
  gaze: {
    sheet: "gaze.webp",
    cols: 5,
    rows: 5,
    cellWidth: 298,
    cellHeight: 110,
    order:
      "row-major, x from -1 to 1, y from up to down, then half blink, then shut",
    center: 12,
    half: 25,
    shut: 26,
  },
};

const MANIFEST_URL = "https://cdn.example.com/faces/abc/manifest.json";

type FaceTestApi = {
  PLATE: number;
  PULL_TAP: number;
  PULL_PAIN: number;
  createEngine: (
    manifest: typeof MANIFEST,
    opts?: {
      now?: () => number;
      random?: () => number;
      reducedMotion?: boolean;
    },
  ) => Engine;
  collectFetchUrls: (
    manifest: typeof MANIFEST,
    manifestUrl: string,
  ) => string[];
  allowedOrigins: (urls: string[]) => Record<string, boolean>;
  createFetchGuard: (
    allowed: Record<string, boolean>,
  ) => (input: string) => Promise<Response>;
  selectRenderPath: (canvas: {
    getContext: (type: string) => unknown;
  }) => "webgl" | "2d" | "img";
  makeSpringState: (reduced: boolean) => SpringState;
  springUsesOvershoot: (state: SpringState) => boolean;
  rubberBand: (travel: number, plateWidth: number) => number;
  grabOffset: (
    vertex: { x: number; y: number },
    grabPoint: { x: number; y: number },
    pointer: { x: number; y: number },
    plateWidth: number,
  ) => { x: number; y: number };
  springStep: (
    vertices: Array<{
      ox: number;
      oy: number;
      x: number;
      y: number;
      vx?: number;
      vy?: number;
    }>,
    dtMs: number,
    reduced: boolean,
  ) => void;
  ExpressionsFace: new () => HTMLElement;
};

type Engine = {
  pointerEnter: (type: string) => void;
  pointerLeave: () => void;
  pointerDown: (type: string) => void;
  pointerUp: (pull: number) => void;
  setPull: (pull: number) => void;
  getSettled: () => string;
  getDisplay: () => string;
  shouldRunGaze: () => boolean;
  updateGaze: (t: number) => number;
  tick: (t: number) => void;
  getNauseaRemaining: (t: number) => number;
  springUsesOvershoot: () => boolean;
  startKeyboardTug: () => boolean;
  pointerCancel: () => void;
  isGrabbing: () => boolean;
};

type SpringState = {
  reduced: boolean;
  overshoot: boolean;
  home: boolean;
};

function minimalDom() {
  class FakeNode {
    childNodes: unknown[] = [];
    style: Record<string, string> = {};
    classList = {
      add: () => {},
      remove: () => {},
    };
    appendChild(child: unknown) {
      this.childNodes.push(child);
      return child;
    }
    addEventListener() {}
    setAttribute() {}
    getAttribute() {
      return null;
    }
  }
  class FakeElement extends FakeNode {}
  class FakeHTMLElement extends FakeElement {
    connectedCallback() {}
    disconnectedCallback() {}
  }
  return {
    HTMLElement: FakeHTMLElement,
    customElements: {
      _defs: new Map<string, unknown>(),
      get(name: string) {
        return this._defs.get(name);
      },
      define(name: string, ctor: unknown) {
        this._defs.set(name, ctor);
      },
    },
    document: {
      hidden: false,
      addEventListener: () => {},
      createElement: () => new FakeElement(),
    },
  };
}

function loadFaceApi(extra?: Record<string, unknown>): FaceTestApi {
  const script = readFileSync(
    path.join(process.cwd(), "public/face.js"),
    "utf8",
  );
  const dom = minimalDom();
  const sandbox: Record<string, unknown> = {
    console,
    setTimeout,
    clearTimeout,
    Uint8Array,
    Float32Array,
    Math,
    Date,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    fetch: () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        blob: () => Promise.resolve(new Blob()),
      }),
    URL,
    matchMedia: () => ({ matches: false }),
    ...dom,
    ...extra,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(script, ctx);
  return sandbox.__EXPRESSIONS_FACE__ as FaceTestApi;
}

function harness(t0 = 1000, reduced = false) {
  let t = t0;
  const api = loadFaceApi();
  const engine = api.createEngine(MANIFEST, {
    now: () => t,
    random: () => 0.5,
    reducedMotion: reduced,
  });
  return {
    engine,
    advance: (ms: number) => {
      t += ms;
      engine.tick(t);
      return t;
    },
    now: () => t,
    api,
  };
}

describe("face.js interaction engine", () => {
  it("does not run gaze during pain", () => {
    const { engine, advance } = harness();
    engine.pointerDown("mouse");
    engine.setPull(0.15);
    expect(engine.getSettled()).toBe("pain");
    expect(engine.shouldRunGaze()).toBe(false);
    advance(100);
    expect(engine.shouldRunGaze()).toBe(false);
  });

  it("shows curious after 120ms mouse rest on smile", () => {
    const { engine, advance } = harness();
    engine.pointerEnter("mouse");
    advance(121);
    expect(engine.getSettled()).toBe("curious");
  });

  it("does not show curious from finger hover alone", () => {
    const { engine, advance } = harness();
    engine.pointerEnter("touch");
    advance(200);
    expect(engine.getSettled()).toBe("smile");
  });

  it("enters pain when pull passes 0.09", () => {
    const { engine } = harness();
    engine.pointerDown("mouse");
    engine.setPull(0.08);
    expect(engine.getSettled()).toBe("curious");
    engine.setPull(0.091);
    expect(engine.getSettled()).toBe("pain");
  });

  it("tap under 0.05 does not start nausea", () => {
    const { engine, advance } = harness();
    engine.pointerDown("mouse");
    engine.setPull(0.04);
    engine.pointerUp(0.04);
    expect(engine.getSettled()).toBe("curious");
    expect(engine.getNauseaRemaining(advance(0))).toBe(0);
  });

  it("nausea duration is 500 + pull * 2200", () => {
    const { engine, now } = harness();
    engine.pointerDown("mouse");
    engine.setPull(0.2);
    engine.pointerUp(0.2);
    const pull = 0.2;
    const expected = 500 + pull * 2200;
    expect(engine.getSettled()).toBe("nausea");
    expect(engine.getNauseaRemaining(now())).toBe(expected);
  });

  it("fourth pull inside 9s holds nausea for 2600ms", () => {
    const { engine, advance } = harness();
    for (let i = 0; i < 3; i++) {
      engine.pointerDown("mouse");
      engine.setPull(0.1);
      engine.pointerUp(0.1);
      advance(500 + 0.1 * 2200 + 300);
    }
    engine.pointerDown("mouse");
    engine.setPull(0.12);
    engine.pointerUp(0.12);
    expect(engine.getSettled()).toBe("nausea");
    expect(engine.getNauseaRemaining(advance(0))).toBe(2600);
  });

  it("reduced motion reports no spring overshoot", () => {
    const { engine, api } = harness(1000, true);
    expect(engine.springUsesOvershoot()).toBe(false);
    const state = api.makeSpringState(true);
    expect(api.springUsesOvershoot(state)).toBe(false);
  });

  it("enter triggers the keyboard tug", () => {
    const { engine } = harness();
    expect(engine.startKeyboardTug()).toBe(true);
    expect(engine.getSettled()).toBe("nausea");
  });

  it("cancelled pointer plays no expression change", () => {
    const { engine, advance } = harness();
    engine.pointerDown("mouse");
    engine.setPull(0.2);
    engine.pointerCancel();
    expect(engine.getSettled()).toBe("pain");
    engine.pointerUp(0.2);
    advance(500);
    expect(engine.getDisplay()).not.toBe("nausea");
  });
});

describe("face.js mesh displacement", () => {
  it("moves the vertex on the grab point to the pointer", () => {
    const api = loadFaceApi();
    const grab = { x: 480, y: 500 };
    const pointer = { x: 510, y: 530 };
    const vertex = { x: grab.x, y: grab.y };
    const off = api.grabOffset(vertex, grab, pointer, api.PLATE);
    expect(vertex.x + off.x).toBeCloseTo(pointer.x, 4);
    expect(vertex.y + off.y).toBeCloseTo(pointer.y, 4);
  });

  it("leaves a vertex outside the grab radius where it is", () => {
    const api = loadFaceApi();
    const grab = { x: 480, y: 500 };
    const pointer = { x: 520, y: 540 };
    const vertex = { x: grab.x + api.PLATE * 0.2, y: grab.y };
    expect(api.PLATE * 0.2).toBeGreaterThan(api.PLATE * 0.07);
    const off = api.grabOffset(vertex, grab, pointer, api.PLATE);
    expect(off).toEqual({ x: 0, y: 0 });
  });

  it("grows slower once travel passes 0.6 of the plate width", () => {
    const api = loadFaceApi();
    const w = api.PLATE;
    const under = api.rubberBand(0.2 * w, w) - api.rubberBand(0, w);
    const over = api.rubberBand(0.8 * w, w) - api.rubberBand(0.6 * w, w);
    expect(over).toBeLessThan(under);
  });

  it("springs a displaced vertex home and does not overshoot with reduced motion", () => {
    const api = loadFaceApi();
    const free = [{ ox: 100, oy: 40, x: 160, y: 70, vx: 0, vy: 0 }];
    const before = Math.hypot(free[0].x - free[0].ox, free[0].y - free[0].oy);
    api.springStep(free, 16, false);
    const after = Math.hypot(free[0].x - free[0].ox, free[0].y - free[0].oy);
    expect(after).toBeLessThan(before);

    const held = [{ ox: 100, oy: 40, x: 160, y: 70, vx: 0, vy: 0 }];
    const signX = Math.sign(held[0].x - held[0].ox);
    const signY = Math.sign(held[0].y - held[0].oy);
    for (let i = 0; i < 40; i++) api.springStep(held, 16, true);
    expect(Math.hypot(held[0].x - held[0].ox, held[0].y - held[0].oy)).toBeLessThan(
      before,
    );
    expect((held[0].x - held[0].ox) * signX).toBeGreaterThanOrEqual(-1e-6);
    expect((held[0].y - held[0].oy) * signY).toBeGreaterThanOrEqual(-1e-6);
  });
});

describe("face.js render path", () => {
  it("selects 2d when webgl is null and 2d is present", () => {
    const api = loadFaceApi();
    const fake2d = {};
    const canvas = {
      getContext(type: string) {
        if (type === "webgl") return null;
        if (type === "2d") return fake2d;
        return null;
      },
    };
    expect(api.selectRenderPath(canvas)).toBe("2d");
  });

  it("leaves img path when both contexts are null", () => {
    const api = loadFaceApi();
    const canvas = {
      getContext() {
        return null;
      },
    };
    expect(api.selectRenderPath(canvas)).toBe("img");
  });
});

describe("face.js fetch guard", () => {
  it("does not fetch hosts other than manifest and its images", async () => {
    const api = loadFaceApi();
    const urls = api.collectFetchUrls(MANIFEST, MANIFEST_URL);
    expect(urls).toContain(MANIFEST_URL);
    expect(urls).toContain(
      "https://cdn.example.com/faces/abc/smile.webp",
    );
    const allowed = api.allowedOrigins(urls);
    const guard = api.createFetchGuard(allowed);

  const fetchCalls: string[] = [];
    const sandbox = loadFaceApi({
      fetch: (input: string) => {
        fetchCalls.push(String(input));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MANIFEST),
          blob: () => Promise.resolve(new Blob()),
        });
      },
      URL,
      customElements: {
        get: () => undefined,
        define: () => {},
      },
      document: { hidden: false, addEventListener: () => {} },
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      Image: class {},
      createImageBitmap: () => Promise.resolve({}),
    });

    await guard(MANIFEST_URL);
    await expect(guard("https://evil.example.com/x")).rejects.toThrow(
      /blocked/,
    );
    expect(fetchCalls.length).toBe(0);
  });
});
