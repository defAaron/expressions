import { describe, expect, it } from "vitest";
import { parseRecipe, type Recipe } from "./recipe";

const GAZE_AXIS = [-100, -50, 0, 50, 100] as const;

function allGazePairs(): Recipe["gaze"] {
  const pairs: Recipe["gaze"][number][] = [];
  for (const eye_gaze_horizontal of GAZE_AXIS) {
    for (const eye_gaze_vertical of GAZE_AXIS) {
      if (eye_gaze_horizontal === 0 && eye_gaze_vertical === 0) continue;
      pairs.push({ eye_gaze_horizontal, eye_gaze_vertical });
    }
  }
  return pairs;
}

const validRecipe = {
  version: 1,
  enhance_face: false,
  curious: { eyebrow_direction: 10 },
  pain: { mouth_grim: -20, eyebrow_direction: -15 },
  gaze: allGazePairs(),
  half_blink: { eye_open_ratio: -50 },
  shut: { eye_open_ratio: -100 },
  nausea_prompt: "crossed eyes, tongue out",
  pain_retry_prompt: "wincing in sharp pain",
};

function recipeWith(patch: Record<string, unknown>): unknown {
  return structuredClone({ ...validRecipe, ...patch });
}

describe("parseRecipe", () => {
  it("parses the inline fixture", () => {
    expect(parseRecipe(validRecipe)).toEqual(validRecipe);
  });

  it("rejects enhance_face: true", () => {
    expect(() => parseRecipe(recipeWith({ enhance_face: true }))).toThrow(
      "enhance_face",
    );
  });

  it("rejects a slider value not on the step grid", () => {
    expect(() =>
      parseRecipe(
        recipeWith({
          curious: { mouth_smile: 3 },
        }),
      ),
    ).toThrow("curious.mouth_smile");
  });

  it("rejects gaze that includes 0, 0", () => {
    const gaze = allGazePairs();
    gaze[0] = { eye_gaze_horizontal: 0, eye_gaze_vertical: 0 };
    expect(() => parseRecipe(recipeWith({ gaze }))).toThrow("gaze");
  });

  it("rejects gaze when a pair is missing from the 24", () => {
    const gaze = allGazePairs().slice(0, 23);
    expect(() => parseRecipe(recipeWith({ gaze }))).toThrow("gaze");
  });

  it("rejects an empty nausea_prompt", () => {
    expect(() => parseRecipe(recipeWith({ nausea_prompt: "" }))).toThrow(
      "nausea_prompt",
    );
  });

  it("rejects a positive eye_open_ratio for shut", () => {
    expect(() =>
      parseRecipe(
        recipeWith({
          shut: { eye_open_ratio: 50 },
        }),
      ),
    ).toThrow("shut.eye_open_ratio");
  });
});
