import { describe, expect, it } from "vitest";
import {
  GAZE_CELL_COUNT,
  GAZE_CENTER,
  GAZE_HALF,
  GAZE_SHUT,
  parseManifest,
} from "./manifest";

const validManifest = {
  version: 1,
  size: [1024, 1024] as [number, number],
  alt: "Alex, smiling",
  eyes: {
    left: [310, 340, 150, 110] as [number, number, number, number],
    right: [560, 338, 148, 110] as [number, number, number, number],
    between: [512, 390] as [number, number],
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

function manifestWith(patch: Record<string, unknown>): unknown {
  return structuredClone({ ...validManifest, ...patch });
}

describe("parseManifest", () => {
  it("parses the canonical manifest", () => {
    expect(parseManifest(validManifest)).toEqual(validManifest);
  });

  it("exposes gaze cell constants", () => {
    expect(GAZE_CELL_COUNT).toBe(27);
    const parsed = parseManifest(validManifest);
    expect(parsed.gaze.center).toBe(GAZE_CENTER);
    expect(parsed.gaze.half).toBe(GAZE_HALF);
    expect(parsed.gaze.shut).toBe(GAZE_SHUT);
    expect(GAZE_CENTER).toBe(12);
    expect(GAZE_HALF).toBe(25);
    expect(GAZE_SHUT).toBe(26);
  });

  it("rejects non-1024 size", () => {
    expect(() =>
      parseManifest(manifestWith({ size: [512, 512] })),
    ).toThrow("size");
  });

  it("rejects invalid gaze indices", () => {
    const badCenter = structuredClone(validManifest);
    badCenter.gaze.center = 0;
    expect(() => parseManifest(badCenter)).toThrow("gaze.center");

    const badHalf = structuredClone(validManifest);
    badHalf.gaze.half = 24;
    expect(() => parseManifest(badHalf)).toThrow("gaze.half");

    const badShut = structuredClone(validManifest);
    badShut.gaze.shut = 27;
    expect(() => parseManifest(badShut)).toThrow("gaze.shut");
  });

  it("rejects unknown plate keys", () => {
    const withShock = structuredClone(validManifest);
    (withShock.plates as Record<string, string>).shock = "shock.webp";
    expect(() => parseManifest(withShock)).toThrow("plates.shock");
  });

  it("rejects unsupported manifest version", () => {
    expect(() => parseManifest(manifestWith({ version: 2 }))).toThrow(
      "version",
    );
  });

  it("rejects gaze.cellWidth when it does not match eye widths", () => {
    const bad = structuredClone(validManifest);
    bad.gaze.cellWidth = 299;
    expect(() => parseManifest(bad)).toThrow("gaze.cellWidth");
  });

  it("rejects plates with curious but no smile", () => {
    const onlyCurious = structuredClone(validManifest);
    onlyCurious.plates = { curious: "curious.webp" };
    expect(() => parseManifest(onlyCurious)).toThrow("plates.smile");
  });

  it("accepts plates containing only smile", () => {
    const onlySmile = structuredClone(validManifest);
    onlySmile.plates = { smile: "smile.webp" };
    expect(parseManifest(onlySmile)).toEqual(onlySmile);
  });

  it("accepts an empty plates object", () => {
    const emptyPlates = structuredClone(validManifest);
    emptyPlates.plates = {};
    const parsed = parseManifest(emptyPlates);
    expect(parsed.plates).toEqual({});
  });
});
