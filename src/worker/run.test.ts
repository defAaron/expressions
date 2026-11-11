import { describe, expect, it, vi } from "vitest";
import type { Recipe } from "../recipe/recipe";
import { parseRecipe } from "../recipe/recipe";
import {
  type FaceStore,
  type PlateGroup,
  type PlateRecord,
  createInMemoryFaceStore,
} from "../api/faces";
import { runFace, type MagicHourClientLike } from "./run";

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

const recipe = parseRecipe({
  version: 1,
  enhance_face: false,
  curious: { eyebrow_direction: 10 },
  pain: { mouth_grim: -20 },
  gaze: allGazePairs(),
  half_blink: { eye_open_ratio: -50 },
  shut: { eye_open_ratio: -100 },
  nausea_prompt: "nausea prompt",
  pain_retry_prompt: "pain retry prompt",
});

async function seedFace(
  store: FaceStore,
  plates?: Partial<Record<PlateGroup, PlateRecord>>,
): Promise<string> {
  const face = await store.createFace({
    sourcePath: "private/faces/x/source",
    smilePath: "public/faces/x/smile.webp",
    likenessAt: new Date(),
  });
  for (const plate of ["curious", "pain", "nausea", "gaze", "blink"] as PlateGroup[]) {
    const row = plates?.[plate];
    if (row) {
      await store.updatePlate(face.id, plate, row);
    }
  }
  return face.id;
}

describe("runFace", () => {
  it("no-ops when the lock is already held", async () => {
    const store = createInMemoryFaceStore();
    const faceId = await seedFace(store);
    await store.tryLock(faceId, "other-token");

    const client: MagicHourClientLike = {
      faceEdit: vi.fn(),
      imageEdit: vi.fn(),
      pollProject: vi.fn(),
    };

    await runFace({
      faceId,
      store,
      client,
      recipe,
      apiKey: "secret-key-value",
      lockToken: "new-token",
    });

    expect(client.faceEdit).not.toHaveBeenCalled();
    expect(client.imageEdit).not.toHaveBeenCalled();
  });

  it("uses imageEdit on pain's second attempt", async () => {
    const store = createInMemoryFaceStore();
    const faceId = await seedFace(store);
    await store.updatePlate(faceId, "pain", {
      plate: "pain",
      status: "queued",
      attempts: 0,
    });

    let painCalls = 0;
    const client: MagicHourClientLike = {
      faceEdit: vi.fn(async (input) => {
        if (input.sliders.mouth_grim !== undefined) {
          painCalls += 1;
          if (painCalls === 1) {
            return { projectId: "p1" };
          }
        }
        return { projectId: "other" };
      }),
      imageEdit: vi.fn(async () => ({ projectId: "img-retry" })),
      pollProject: vi.fn(async (projectId) => {
        if (projectId === "p1") {
          return { status: "error", message: "locker fail" };
        }
        return { status: "complete", imageUrl: "https://cdn/out.webp" };
      }),
    };

    await runFace({
      faceId,
      store,
      client,
      recipe,
      apiKey: "secret-key-value",
      lockToken: "tok",
      plates: ["pain"],
    });

    expect(client.imageEdit).toHaveBeenCalledWith({
      imageFilePath: "public/faces/x/smile.webp",
      prompt: "pain retry prompt",
    });
    const pain = await store.getPlate(faceId, "pain");
    expect(pain?.status).toBe("ready");
  });

  it("keeps at most four client calls in flight", async () => {
    const store = createInMemoryFaceStore();
    const faceId = await seedFace(store);
    for (const plate of ["curious", "pain", "nausea", "gaze", "blink"] as PlateGroup[]) {
      await store.updatePlate(faceId, plate, {
        plate,
        status: "queued",
        attempts: 0,
      });
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const releaseQueue: Array<() => void> = [];

    const client: MagicHourClientLike = {
      faceEdit: vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => releaseQueue.push(resolve));
        inFlight -= 1;
        return { projectId: `proj-${Math.random()}` };
      }),
      imageEdit: vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => releaseQueue.push(resolve));
        inFlight -= 1;
        return { projectId: `img-${Math.random()}` };
      }),
      pollProject: vi.fn(async () => ({
        status: "complete",
        imageUrl: "https://cdn/out.webp",
      })),
    };

    const runPromise = runFace({
      faceId,
      store,
      client,
      recipe,
      apiKey: "secret-key-value",
      lockToken: "tok",
    });

    const releaser = (async () => {
      while (true) {
        while (releaseQueue.length > 0) {
          releaseQueue.shift()?.();
        }
        const done = await Promise.race([
          runPromise.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5)),
        ]);
        if (done) break;
      }
    })();
    void releaser;

    while (maxInFlight < 4) {
      while (releaseQueue.length > 0) {
        releaseQueue.shift()?.();
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(maxInFlight).toBeLessThanOrEqual(4);
    await runPromise;
    await releaser;
  });

  it("adds a plate to the manifest when it becomes ready", async () => {
    const store = createInMemoryFaceStore();
    const faceId = await seedFace(store);
    await store.updatePlate(faceId, "curious", {
      plate: "curious",
      status: "queued",
      attempts: 0,
    });

    const client: MagicHourClientLike = {
      faceEdit: vi.fn(async () => ({ projectId: "curious-1" })),
      imageEdit: vi.fn(),
      pollProject: vi.fn(async () => ({
        status: "complete",
        imageUrl: "https://cdn/curious.webp",
      })),
    };

    await runFace({
      faceId,
      store,
      client,
      recipe,
      apiKey: "secret-key-value",
      lockToken: "tok",
      plates: ["curious"],
    });

    const manifest = await store.readManifest(faceId);
    expect(manifest).toBeTruthy();
    const plates = (manifest as { plates?: Record<string, string> }).plates;
    expect(plates?.smile).toBeDefined();
    expect(plates?.curious).toBeDefined();
  });
});
