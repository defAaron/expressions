import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseRecipe, type Recipe } from "../recipe/recipe";
import { sourcePath } from "../storage/blobs";
import {
  createInMemoryFaceStore,
  type FaceApiDeps,
  createFaceHandlers,
  type PlateGroup,
  IpRateLimiter,
} from "./faces";

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

const recipeJson = JSON.stringify({
  version: 1,
  enhance_face: false,
  curious: { eyebrow_direction: 10 },
  pain: { mouth_grim: -20 },
  gaze: allGazePairs(),
  half_blink: { eye_open_ratio: -50 },
  shut: { eye_open_ratio: -100 },
  nausea_prompt: "nausea",
  pain_retry_prompt: "pain retry",
});

const recipe = parseRecipe(JSON.parse(recipeJson));

function baseDeps(overrides: Partial<FaceApiDeps> = {}): FaceApiDeps {
  const store = overrides.store ?? createInMemoryFaceStore();
  return {
    store,
    readRecipe: () => recipeJson,
    parseRecipe,
    baseUrl: "https://app.example",
    prepare: () => ({ ok: true as const, smilePath: "public/faces/t/smile.webp" }),
    rateLimit: new IpRateLimiter(10, 60_000),
    newFaceId: () => randomBytes(16).toString("hex"),
    runWorker: vi.fn(async () => {}),
    createClient: () => ({
      faceEdit: vi.fn(),
      imageEdit: vi.fn(),
      pollProject: vi.fn(),
    }),
    ...overrides,
  };
}

function multipartBody(fields: Record<string, string | Blob>): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return new Request("https://app.example/api/faces", {
    method: "POST",
    body: form,
  });
}

function withIp(request: Request, ip: string): Request {
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-for", ip);
  return new Request(request, { headers });
}

function withBearer(request: Request, key: string): Request {
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${key}`);
  return new Request(request, { headers });
}

async function seedReadyFace(
  deps: FaceApiDeps,
  patch?: Partial<{ pain: boolean; nausea: boolean; smile: boolean }>,
): Promise<string> {
  const id = randomBytes(16).toString("hex");
  await deps.store.createFace({
    id,
    sourcePath: sourcePath(id),
    smilePath: patch?.smile === false ? undefined : `public/faces/${id}/smile.webp`,
    likenessAt: new Date(),
  });
  for (const plate of ["curious", "pain", "nausea", "gaze", "blink"] as PlateGroup[]) {
    await deps.store.updatePlate(id, plate, {
      plate,
      status: "queued",
      attempts: 0,
    });
  }
  if (patch?.pain !== false) {
    await deps.store.updatePlate(id, "pain", {
      plate: "pain",
      status: "ready",
      attempts: 1,
    });
  }
  if (patch?.nausea !== false) {
    await deps.store.updatePlate(id, "nausea", {
      plate: "nausea",
      status: "ready",
      attempts: 1,
    });
  }
  return id;
}

describe("face API handlers", () => {
  const handlers = () => createFaceHandlers();

  it("rejects missing likeness before storing anything", async () => {
    const store = createInMemoryFaceStore();
    const deps = baseDeps({ store });
    const h = handlers();
    const request = multipartBody({
      file: new Blob([new Uint8Array([1, 2, 3])]),
      mediaType: "image/jpeg",
      likeness: "no",
    });
    const response = await h.postFaces(request, deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "likeness_required" });
    expect(store.faces.size).toBe(0);
  });

  it("rejects a bad file before calling the client", async () => {
    const client = {
      faceEdit: vi.fn(),
      imageEdit: vi.fn(),
      pollProject: vi.fn(),
    };
    const runWorker = vi.fn();
    const deps = baseDeps({
      prepare: () => ({ ok: false as const, error: "bad_face" }),
      runWorker,
      createClient: () => client,
    });
    const h = handlers();
    const request = withBearer(
      multipartBody({
        file: new Blob([new Uint8Array([1])]),
        mediaType: "image/jpeg",
        likeness: "yes",
      }),
      "secret-key-value",
    );
    const response = await h.postFaces(request, deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_face" });
    expect(runWorker).not.toHaveBeenCalled();
    expect(client.faceEdit).not.toHaveBeenCalled();
  });

  it("returns 401 when the bearer key is missing", async () => {
    const runWorker = vi.fn();
    const deps = baseDeps({ runWorker });
    const h = handlers();
    const request = multipartBody({
      file: new Blob([new Uint8Array([1])]),
      mediaType: "image/jpeg",
      likeness: "yes",
    });
    const response = await h.postFaces(request, deps);
    expect(response.status).toBe(401);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("rate limits POST /api/faces by IP", async () => {
    const deps = baseDeps();
    const h = handlers();
  const ip = "203.0.113.50";
    for (let i = 0; i < 10; i += 1) {
      const request = withIp(
        withBearer(
          multipartBody({
            file: new Blob([new Uint8Array([1])]),
            mediaType: "image/jpeg",
            likeness: "yes",
          }),
          "secret-key-value",
        ),
        ip,
      );
      const response = await h.postFaces(request, deps);
      expect(response.status).toBe(200);
    }
    const blocked = await h.postFaces(
      withIp(
        withBearer(
          multipartBody({
            file: new Blob([new Uint8Array([1])]),
            mediaType: "image/jpeg",
            likeness: "yes",
          }),
          "secret-key-value",
        ),
        ip,
      ),
      deps,
    );
    expect(blocked.status).toBe(429);
  });

  const notFoundCases = [
    "getFace",
    "postRetry",
    "postAccept",
    "deleteFace",
  ] as const;

  for (const name of notFoundCases) {
    it(`returns the same not_found 404 for ${name}`, async () => {
      const deps = baseDeps();
      const h = handlers();
      const missing = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const responses = {
        getFace: await h.getFace(
          new Request(`https://app.example/api/faces/${missing}`),
          { params: { id: missing } },
          deps,
        ),
        postRetry: await h.postRetry(
          withBearer(
            new Request(`https://app.example/api/faces/${missing}/retry`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ plate: "pain" }),
            }),
            "secret-key-value",
          ),
          { params: { id: missing } },
          deps,
        ),
        postAccept: await h.postAccept(
          new Request(`https://app.example/api/faces/${missing}/accept`, {
            method: "POST",
          }),
          { params: { id: missing } },
          deps,
        ),
        deleteFace: await h.deleteFace(
          new Request(`https://app.example/api/faces/${missing}`, {
            method: "DELETE",
          }),
          { params: { id: missing } },
          deps,
        ),
      };
      const response = responses[name];
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    });
  }

  it("accept returns not_ready until pain and nausea are ready", async () => {
    const deps = baseDeps();
    const h = handlers();
    const id = await seedReadyFace(deps, { pain: false });
    const response = await h.postAccept(
      new Request(`https://app.example/api/faces/${id}/accept`, { method: "POST" }),
      { params: { id } },
      deps,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_ready" });
  });

  it("enforces retry budget", async () => {
    const deps = baseDeps();
    const h = handlers();
    const id = await seedReadyFace(deps);
    await deps.store.updatePlate(id, "pain", {
      plate: "pain",
      status: "failed",
      attempts: 4,
    });
    const response = await h.postRetry(
      withBearer(
        new Request(`https://app.example/api/faces/${id}/retry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plate: "pain" }),
        }),
        "secret-key-value",
      ),
      { params: { id } },
      deps,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "retry_budget" });
  });

  it("starts the worker spy after a successful upload", async () => {
    const runWorker = vi.fn(async () => {});
    const deps = baseDeps({ runWorker });
    const h = handlers();
    const response = await h.postFaces(
      withBearer(
        multipartBody({
          file: new Blob([new Uint8Array([9])]),
          mediaType: "image/jpeg",
          likeness: "yes",
        }),
        "secret-key-value",
      ),
      deps,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    expect(body.id).toMatch(/^[a-f0-9]{32}$/);
    expect(runWorker).toHaveBeenCalledTimes(1);
    const args = runWorker.mock.calls[0]?.[0] as { apiKey?: string };
    expect(args.apiKey).toBe("secret-key-value");
  });
});
