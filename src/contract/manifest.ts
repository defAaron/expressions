export const MANIFEST_SIZE = 1024;
export const GAZE_CELL_COUNT = 27;
export const GAZE_CENTER = 12;
export const GAZE_HALF = 25;
export const GAZE_SHUT = 26;

const PLATE_KEYS = ["smile", "curious", "pain", "nausea"] as const;
type PlateKey = (typeof PLATE_KEYS)[number];

const GAZE_ORDER =
  "row-major, x from -1 to 1, y from up to down, then half blink, then shut";

export type Manifest = {
  version: 1;
  size: [typeof MANIFEST_SIZE, typeof MANIFEST_SIZE];
  alt: string;
  eyes: {
    left: [number, number, number, number];
    right: [number, number, number, number];
    between: [number, number];
  };
  plates: Partial<Record<PlateKey, string>>;
  gaze: {
    sheet: string;
    cols: 5;
    rows: 5;
    cellWidth: number;
    cellHeight: number;
    order: typeof GAZE_ORDER;
    center: typeof GAZE_CENTER;
    half: typeof GAZE_HALF;
    shut: typeof GAZE_SHUT;
  };
};

function fail(field: string): never {
  throw new Error(field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (!isFiniteNumber(value)) fail(field);
  return value;
}

function requireTuple4(
  value: unknown,
  field: string,
): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) fail(field);
  return [
    requireFiniteNumber(value[0], field),
    requireFiniteNumber(value[1], field),
    requireFiniteNumber(value[2], field),
    requireFiniteNumber(value[3], field),
  ];
}

function requireTuple2(
  value: unknown,
  field: string,
): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) fail(field);
  return [
    requireFiniteNumber(value[0], field),
    requireFiniteNumber(value[1], field),
  ];
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(field);
  return value;
}

function isPlateKey(key: string): key is PlateKey {
  return (PLATE_KEYS as readonly string[]).includes(key);
}

export function parseManifest(value: unknown): Manifest {
  if (!isRecord(value)) fail("manifest");

  if (value.version !== 1) fail("version");

  const size = value.size;
  if (
    !Array.isArray(size) ||
    size.length !== 2 ||
    size[0] !== MANIFEST_SIZE ||
    size[1] !== MANIFEST_SIZE
  ) {
    fail("size");
  }

  if (typeof value.alt !== "string") fail("alt");
  const alt = value.alt;

  if (!isRecord(value.eyes)) fail("eyes");
  const left = requireTuple4(value.eyes.left, "eyes.left");
  const right = requireTuple4(value.eyes.right, "eyes.right");
  const between = requireTuple2(value.eyes.between, "eyes.between");

  if (left[3] !== right[3]) fail("eyes");

  if (!isRecord(value.gaze)) fail("gaze");

  const gazeSheet = requireNonEmptyString(value.gaze.sheet, "gaze.sheet");

  if (value.gaze.cols !== 5) fail("gaze.cols");
  if (value.gaze.rows !== 5) fail("gaze.rows");

  const cellHeight = requireFiniteNumber(value.gaze.cellHeight, "gaze.cellHeight");
  if (left[3] !== cellHeight) fail("gaze.cellHeight");

  const cellWidth = requireFiniteNumber(value.gaze.cellWidth, "gaze.cellWidth");
  const expectedCellWidth = left[2] + right[2];
  if (cellWidth !== expectedCellWidth) fail("gaze.cellWidth");

  if (value.gaze.order !== GAZE_ORDER) fail("gaze.order");

  if (value.gaze.center !== GAZE_CENTER) fail("gaze.center");
  if (value.gaze.half !== GAZE_HALF) fail("gaze.half");
  if (value.gaze.shut !== GAZE_SHUT) fail("gaze.shut");

  if (value.plates === undefined) fail("plates");
  if (!isRecord(value.plates)) fail("plates");

  const plates: Partial<Record<PlateKey, string>> = {};
  const plateKeys = Object.keys(value.plates);

  for (const key of plateKeys) {
    if (!isPlateKey(key)) fail(`plates.${key}`);
    plates[key] = requireNonEmptyString(value.plates[key], `plates.${key}`);
  }

  if (plateKeys.length > 0 && !("smile" in plates)) {
    fail("plates.smile");
  }

  return {
    version: 1,
    size: [MANIFEST_SIZE, MANIFEST_SIZE],
    alt,
    eyes: { left, right, between },
    plates,
    gaze: {
      sheet: gazeSheet,
      cols: 5,
      rows: 5,
      cellWidth,
      cellHeight,
      order: GAZE_ORDER,
      center: GAZE_CENTER,
      half: GAZE_HALF,
      shut: GAZE_SHUT,
    },
  };
}
