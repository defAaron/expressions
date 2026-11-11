export const SLIDER_NAMES = [
  "eye_gaze_horizontal",
  "eye_gaze_vertical",
  "eye_open_ratio",
  "eyebrow_direction",
  "mouth_smile",
  "mouth_grim",
  "lip_open_ratio",
  "mouth_position_vertical",
  "head_pitch",
  "head_yaw",
  "head_roll",
] as const;

export type SliderName = (typeof SLIDER_NAMES)[number];

type SliderMap = Partial<Record<SliderName, number>>;

const GAZE_AXIS_VALUES = [-100, -50, 0, 50, 100] as const;

export type GazeEntry = {
  eye_gaze_horizontal: (typeof GAZE_AXIS_VALUES)[number];
  eye_gaze_vertical: (typeof GAZE_AXIS_VALUES)[number];
};

export type Recipe = {
  version: 1;
  enhance_face: false;
  curious: SliderMap;
  pain: SliderMap;
  gaze: GazeEntry[];
  half_blink: { eye_open_ratio: number };
  shut: { eye_open_ratio: number };
  nausea_prompt: string;
  pain_retry_prompt: string;
};

function fail(field: string): never {
  throw new Error(field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSliderName(key: string): key is SliderName {
  return (SLIDER_NAMES as readonly string[]).includes(key);
}

function isSliderStep(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= -100 &&
    value <= 100 &&
    value % 5 === 0
  );
}

function requireSliderValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(field);
  if (!isSliderStep(value)) fail(field);
  return value;
}

function parseSliderMap(
  value: unknown,
  field: string,
): SliderMap {
  if (!isRecord(value)) fail(field);
  const map: SliderMap = {};
  for (const key of Object.keys(value)) {
    if (!isSliderName(key)) fail(`${field}.${key}`);
    map[key] = requireSliderValue(value[key], `${field}.${key}`);
  }
  return map;
}

function isGazeAxis(value: number): value is (typeof GAZE_AXIS_VALUES)[number] {
  return (GAZE_AXIS_VALUES as readonly number[]).includes(value);
}

function parseGaze(value: unknown): GazeEntry[] {
  if (!Array.isArray(value) || value.length !== 24) fail("gaze");

  const seen = new Set<string>();
  const gaze: GazeEntry[] = [];

  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    const prefix = `gaze[${i}]`;
    if (!isRecord(entry)) fail(prefix);

    const keys = Object.keys(entry);
    if (
      keys.length !== 2 ||
      !keys.includes("eye_gaze_horizontal") ||
      !keys.includes("eye_gaze_vertical")
    ) {
      fail(prefix);
    }

    const eye_gaze_horizontal = entry.eye_gaze_horizontal;
    const eye_gaze_vertical = entry.eye_gaze_vertical;

    if (
      typeof eye_gaze_horizontal !== "number" ||
      typeof eye_gaze_vertical !== "number" ||
      !Number.isFinite(eye_gaze_horizontal) ||
      !Number.isFinite(eye_gaze_vertical)
    ) {
      fail(prefix);
    }

    if (!isGazeAxis(eye_gaze_horizontal) || !isGazeAxis(eye_gaze_vertical)) {
      fail(prefix);
    }

    if (eye_gaze_horizontal === 0 && eye_gaze_vertical === 0) fail("gaze");

    const pairKey = `${eye_gaze_horizontal},${eye_gaze_vertical}`;
    if (seen.has(pairKey)) fail("gaze");
    seen.add(pairKey);

    gaze.push({ eye_gaze_horizontal, eye_gaze_vertical });
  }

  for (const h of GAZE_AXIS_VALUES) {
    for (const v of GAZE_AXIS_VALUES) {
      if (h === 0 && v === 0) continue;
      if (!seen.has(`${h},${v}`)) fail("gaze");
    }
  }

  return gaze;
}

function requireNegativeSlider(
  value: unknown,
  field: string,
): { eye_open_ratio: number } {
  if (!isRecord(value)) fail(field);
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "eye_open_ratio") fail(field);

  const eye_open_ratio = requireSliderValue(value.eye_open_ratio, `${field}.eye_open_ratio`);
  if (eye_open_ratio >= 0) fail(`${field}.eye_open_ratio`);
  return { eye_open_ratio };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(field);
  return value;
}

export function parseRecipe(value: unknown): Recipe {
  if (!isRecord(value)) fail("recipe");

  if (value.version !== 1) fail("version");
  if (value.enhance_face !== false) fail("enhance_face");

  const curious = parseSliderMap(value.curious, "curious");
  const pain = parseSliderMap(value.pain, "pain");
  const gaze = parseGaze(value.gaze);
  const half_blink = requireNegativeSlider(value.half_blink, "half_blink");
  const shut = requireNegativeSlider(value.shut, "shut");
  const nausea_prompt = requireNonEmptyString(value.nausea_prompt, "nausea_prompt");
  const pain_retry_prompt = requireNonEmptyString(
    value.pain_retry_prompt,
    "pain_retry_prompt",
  );

  return {
    version: 1,
    enhance_face: false,
    curious,
    pain,
    gaze,
    half_blink,
    shut,
    nausea_prompt,
    pain_retry_prompt,
  };
}
