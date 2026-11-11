import type { GazeEntry, Recipe } from "../recipe/recipe";
import type { FaceStore, PlateGroup } from "../api/faces";

export type MagicHourClientLike = {
  faceEdit(input: {
    imageFilePath: string;
    sliders: Record<string, number>;
  }): Promise<{ projectId: string }>;
  imageEdit(input: {
    imageFilePath: string;
    prompt: string;
  }): Promise<{ projectId: string }>;
  pollProject(
    projectId: string,
  ): Promise<
    | { status: "complete"; imageUrl: string }
    | { status: "error"; message: string }
  >;
};

type WorkItem =
  | { kind: "curious" }
  | { kind: "pain" }
  | { kind: "nausea" }
  | { kind: "gaze"; entry: GazeEntry }
  | { kind: "half_blink" }
  | { kind: "shut" };

function gazeChebyshev(entry: GazeEntry): number {
  const hx = Math.abs(entry.eye_gaze_horizontal) / 50;
  const hy = Math.abs(entry.eye_gaze_vertical) / 50;
  return Math.max(hx, hy);
}

function sortedGaze(recipe: Recipe): GazeEntry[] {
  return [...recipe.gaze].sort((a, b) => {
    const da = gazeChebyshev(a);
    const db = gazeChebyshev(b);
    if (da !== db) return da - db;
    if (a.eye_gaze_horizontal !== b.eye_gaze_horizontal) {
      return a.eye_gaze_horizontal - b.eye_gaze_horizontal;
    }
    return a.eye_gaze_vertical - b.eye_gaze_vertical;
  });
}

function plateGroupForItem(item: WorkItem): PlateGroup {
  if (item.kind === "gaze" || item.kind === "half_blink" || item.kind === "shut") {
    return item.kind === "gaze" ? "gaze" : "blink";
  }
  return item.kind;
}

function buildQueue(
  recipe: Recipe,
  plates: PlateGroup[] | undefined,
  allowed: Set<PlateGroup>,
): WorkItem[] {
  const queue: WorkItem[] = [];
  const want = (group: PlateGroup) =>
    (!plates || plates.includes(group)) && allowed.has(group);

  if (want("curious")) queue.push({ kind: "curious" });
  if (want("pain")) queue.push({ kind: "pain" });
  if (want("nausea")) queue.push({ kind: "nausea" });
  if (want("gaze")) {
    for (const entry of sortedGaze(recipe)) {
      queue.push({ kind: "gaze", entry });
    }
  }
  if (want("blink")) {
    queue.push({ kind: "half_blink" }, { kind: "shut" });
  }
  return queue;
}

async function runPool(
  items: WorkItem[],
  concurrency: number,
  worker: (item: WorkItem) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

async function callClient(
  client: MagicHourClientLike,
  item: WorkItem,
  recipe: Recipe,
  imageFilePath: string,
  attempt: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let projectId: string;
  try {
    if (item.kind === "pain" && attempt === 1) {
      const result = await client.imageEdit({
        imageFilePath,
        prompt: recipe.pain_retry_prompt,
      });
      projectId = result.projectId;
    } else if (item.kind === "pain") {
      const result = await client.faceEdit({
        imageFilePath,
        sliders: recipe.pain,
      });
      projectId = result.projectId;
    } else if (item.kind === "nausea") {
      const result = await client.imageEdit({
        imageFilePath,
        prompt: recipe.nausea_prompt,
      });
      projectId = result.projectId;
    } else if (item.kind === "curious") {
      const result = await client.faceEdit({
        imageFilePath,
        sliders: recipe.curious,
      });
      projectId = result.projectId;
    } else if (item.kind === "gaze") {
      const result = await client.faceEdit({
        imageFilePath,
        sliders: {
          eye_gaze_horizontal: item.entry.eye_gaze_horizontal,
          eye_gaze_vertical: item.entry.eye_gaze_vertical,
        },
      });
      projectId = result.projectId;
    } else if (item.kind === "half_blink") {
      const result = await client.faceEdit({
        imageFilePath,
        sliders: recipe.half_blink,
      });
      projectId = result.projectId;
    } else {
      const result = await client.faceEdit({
        imageFilePath,
        sliders: recipe.shut,
      });
      projectId = result.projectId;
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Magic Hour request failed.";
    return { ok: false, message };
  }

  const polled = await client.pollProject(projectId);
  if (polled.status === "complete") {
    return { ok: true };
  }
  return { ok: false, message: polled.message };
}

export async function runFace(input: {
  faceId: string;
  store: FaceStore;
  client: MagicHourClientLike;
  recipe: Recipe;
  apiKey: string;
  lockToken: string;
  plates?: PlateGroup[];
}): Promise<void> {
  void input.apiKey;

  const acquired = await input.store.tryLock(input.faceId, input.lockToken);
  if (!acquired) return;

  try {
    const smilePath = input.store.getSmileFilePath(input.faceId);
    if (!smilePath) return;

    const rows = await input.store.listPlates(input.faceId);
    const allowed = new Set(
      rows.filter((row) => row.status !== "ready").map((row) => row.plate),
    );
    const queue = buildQueue(input.recipe, input.plates, allowed);

    await runPool(queue, 4, async (item) => {
      const group = plateGroupForItem(item);
      const row = await input.store.getPlate(input.faceId, group);
      if (!row || row.status === "ready") return;

      await input.store.updatePlate(input.faceId, group, {
        status: "running",
      });

      let lastError = "generation failed";
      let succeeded = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await input.store.getPlate(input.faceId, group);
        await input.store.updatePlate(input.faceId, group, {
          attempts: (current?.attempts ?? 0) + 1,
        });

        const outcome = await callClient(
          input.client,
          item,
          input.recipe,
          smilePath,
          attempt,
        );
        if (outcome.ok) {
          succeeded = true;
          if (item.kind === "curious") {
            input.store.notePlateAsset(input.faceId, "curious", "curious.webp");
          } else if (item.kind === "pain") {
            input.store.notePlateAsset(input.faceId, "pain", "pain.webp");
          } else if (item.kind === "nausea") {
            input.store.notePlateAsset(input.faceId, "nausea", "nausea.webp");
          } else if (item.kind === "gaze") {
            input.store.notePlateAsset(input.faceId, "gaze", "gaze.webp");
          }
          await input.store.updatePlate(input.faceId, group, {
            status: "ready",
            error: undefined,
          });
          await input.store.writeManifest(input.faceId);
          break;
        }
        lastError = outcome.message;
      }

      if (!succeeded) {
        await input.store.updatePlate(input.faceId, group, {
          status: "failed",
          error: lastError,
        });
      }
    });
  } finally {
    await input.store.unlock(input.faceId, input.lockToken);
  }
}
