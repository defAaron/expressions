import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Manifest } from "../contract/manifest";
import { createMediaPipeDetector, cropToSmile } from "../locker/crop";
import type { SmileLandmarks } from "../locker/types";
import { createMagicHourClient } from "../magic-hour/client";
import { createLiveMagicHourClient } from "../magic-hour/live";
import { assertRecipePresent } from "../magic-hour/recipe-gate";
import { parseRecipe, type Recipe } from "../recipe/recipe";
import { bundlePath, sourcePath } from "../storage/blobs";
import { createPlatePersister, writeSmileLandmarks } from "../worker/persist";
import { runFace } from "../worker/run";

export type PlateGroup = "curious" | "pain" | "nausea" | "gaze" | "blink";
export type PlateStatus = "queued" | "running" | "ready" | "failed";
export type FaceStatus = "drafting" | "ready" | "accepted" | "failed";

export type PlateRecord = {
  plate: PlateGroup;
  status: PlateStatus;
  attempts: number;
  error?: string;
};

export type FaceRecord = {
  id: string;
  status: FaceStatus;
  sourcePath: string;
  manifestPath?: string;
  smilePath?: string;
  likenessAt: Date;
  workerToken?: string;
};

export type PrepareResult =
  | { ok: true; smilePath: string }
  | { ok: false; error: string };

export interface FaceStore {
  faces: Map<string, FaceRecord>;
  createFace(input: {
    id?: string;
    sourcePath: string;
    smilePath?: string;
    likenessAt: Date;
  }): Promise<FaceRecord>;
  getFace(id: string): Promise<FaceRecord | null>;
  deleteFace(id: string): Promise<boolean>;
  updateFace(id: string, patch: Partial<FaceRecord>): Promise<void>;
  updatePlate(
    faceId: string,
    plate: PlateGroup,
    patch: Partial<PlateRecord>,
  ): Promise<void>;
  getPlate(faceId: string, plate: PlateGroup): Promise<PlateRecord | null>;
  listPlates(faceId: string): Promise<PlateRecord[]>;
  tryLock(faceId: string, token: string): Promise<boolean>;
  unlock(faceId: string, token: string): Promise<void>;
  writeManifest(faceId: string): Promise<string>;
  getManifestUrl(faceId: string): Promise<string | undefined>;
  readManifest(faceId: string): Promise<unknown | undefined>;
  deleteSource(faceId: string): Promise<void>;
  deleteBundle(faceId: string): Promise<void>;
  getSmileFilePath(faceId: string): string | undefined;
  notePlateAsset(faceId: string, key: string, fileName: string): void;
}

export class IpRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(ip: string): boolean {
    const now = Date.now();
    const kept = (this.buckets.get(ip) ?? []).filter(
      (timestamp) => now - timestamp < this.windowMs,
    );
    if (kept.length >= this.max) {
      this.buckets.set(ip, kept);
      return false;
    }
    kept.push(now);
    this.buckets.set(ip, kept);
    return true;
  }
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

export function bearerKey(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const key = header.slice("Bearer ".length).trim();
  return key.length > 0 ? key : null;
}

const PLATE_GROUPS: PlateGroup[] = [
  "curious",
  "pain",
  "nausea",
  "gaze",
  "blink",
];

const RETRY_BUDGET: Record<PlateGroup, number> = {
  curious: 2,
  pain: 4,
  nausea: 4,
  gaze: 2,
  blink: 2,
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(): Response {
  return json({ error: "not_found" }, 404);
}

function defaultManifestSkeleton(faceId: string): Manifest {
  return {
    version: 1,
    size: [1024, 1024],
    alt: "face",
    eyes: {
      left: [310, 340, 150, 110],
      right: [560, 338, 148, 110],
      between: [512, 390],
    },
    plates: {},
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
}

export function createInMemoryFaceStore(): FaceStore {
  const faces = new Map<string, FaceRecord>();
  const plates = new Map<string, Map<PlateGroup, PlateRecord>>();
  const manifests = new Map<string, unknown>();
  const assets = new Map<string, Map<string, string>>();
  const deletedSources = new Set<string>();
  const deletedBundles = new Set<string>();

  const store: FaceStore = {
    faces,

    async createFace(input) {
      const id = input.id ?? randomBytes(16).toString("hex");
      const record: FaceRecord = {
        id,
        status: "drafting",
        sourcePath: input.sourcePath,
        smilePath: input.smilePath,
        likenessAt: input.likenessAt,
      };
      faces.set(id, record);
      const plateMap = new Map<PlateGroup, PlateRecord>();
      for (const plate of PLATE_GROUPS) {
        plateMap.set(plate, {
          plate,
          status: "queued",
          attempts: 0,
        });
      }
      plates.set(id, plateMap);
      assets.set(id, new Map());
      return record;
    },

    async getFace(id) {
      return faces.get(id) ?? null;
    },

    async deleteFace(id) {
      if (!faces.has(id)) return false;
      faces.delete(id);
      plates.delete(id);
      manifests.delete(id);
      assets.delete(id);
      return true;
    },

    async updateFace(id, patch) {
      const face = faces.get(id);
      if (!face) return;
      faces.set(id, { ...face, ...patch });
    },

    async updatePlate(faceId, plate, patch) {
      const map = plates.get(faceId);
      if (!map) return;
      const current = map.get(plate);
      if (!current) return;
      map.set(plate, { ...current, ...patch, plate });
    },

    async getPlate(faceId, plate) {
      return plates.get(faceId)?.get(plate) ?? null;
    },

    async listPlates(faceId) {
      const map = plates.get(faceId);
      if (!map) return [];
      return PLATE_GROUPS.map((plate) => map.get(plate)!);
    },

    async tryLock(faceId, token) {
      const face = faces.get(faceId);
      if (!face) return false;
      if (face.workerToken) return false;
      face.workerToken = token;
      faces.set(faceId, face);
      return true;
    },

    async unlock(faceId, token) {
      const face = faces.get(faceId);
      if (!face) return;
      if (face.workerToken === token) {
        face.workerToken = undefined;
        faces.set(faceId, face);
      }
    },

    notePlateAsset(faceId, key, fileName) {
      const map = assets.get(faceId) ?? new Map();
      map.set(key, fileName);
      assets.set(faceId, map);
    },

    async writeManifest(faceId) {
      const face = faces.get(faceId);
      if (!face) throw new Error("face missing");
      const manifest = defaultManifestSkeleton(faceId);
      const ready = await store.listPlates(faceId);
      const assetMap = assets.get(faceId) ?? new Map();
      if (face.smilePath) {
        manifest.plates.smile = "smile.webp";
      }
      if (ready.find((p) => p.plate === "curious")?.status === "ready") {
        manifest.plates.curious =
          assetMap.get("curious") ?? "curious.webp";
      }
      if (ready.find((p) => p.plate === "pain")?.status === "ready") {
        manifest.plates.pain = assetMap.get("pain") ?? "pain.webp";
      }
      if (ready.find((p) => p.plate === "nausea")?.status === "ready") {
        manifest.plates.nausea = assetMap.get("nausea") ?? "nausea.webp";
      }
      if (ready.find((p) => p.plate === "gaze")?.status === "ready") {
        manifest.gaze.sheet = assetMap.get("gaze") ?? "gaze.webp";
      }
      const path = bundlePath(faceId, "manifest.json");
      face.manifestPath = path;
      faces.set(faceId, face);
      manifests.set(faceId, manifest);
      return `https://cdn.example/${path}`;
    },

    async getManifestUrl(faceId) {
      const face = faces.get(faceId);
      if (!face?.smilePath) return undefined;
      const path = face.manifestPath ?? bundlePath(faceId, "manifest.json");
      return `https://cdn.example/${path}`;
    },

    async readManifest(faceId) {
      return manifests.get(faceId);
    },

    async deleteSource(faceId) {
      deletedSources.add(faceId);
    },

    async deleteBundle(faceId) {
      deletedBundles.add(faceId);
    },

    getSmileFilePath(faceId) {
      return faces.get(faceId)?.smilePath;
    },
  };

  return store;
}

export type FaceApiDeps = {
  store: FaceStore;
  readRecipe: () => string | undefined;
  parseRecipe: typeof parseRecipe;
  baseUrl: string;
  prepare: (
    bytes: Buffer,
    mediaType: string,
    faceId: string,
  ) => PrepareResult | Promise<PrepareResult>;
  rateLimit: IpRateLimiter;
  newFaceId: () => string;
  runWorker: (input: {
    faceId: string;
    apiKey: string;
    plates?: PlateGroup[];
  }) => Promise<void>;
  createClient: typeof createMagicHourClient;
};

function appOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_APP_ORIGIN?.replace(/\/$/, "") ??
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3456")
  );
}

async function stampEyes(faceId: string, manifest: Manifest): Promise<void> {
  try {
    const raw = await readFile(
      path.join(process.cwd(), bundlePath(faceId, "landmarks.json")),
      "utf8",
    );
    const landmarks = JSON.parse(raw) as SmileLandmarks;
    const left = landmarks.leftEye;
    const right = landmarks.rightEye;
    manifest.eyes = {
      left: [
        Math.round(left.x),
        Math.round(left.y),
        Math.round(left.width),
        Math.round(left.height),
      ],
      right: [
        Math.round(right.x),
        Math.round(right.y),
        Math.round(right.width),
        Math.round(right.height),
      ],
      between: [
        Math.round(landmarks.betweenPupils.x),
        Math.round(landmarks.betweenPupils.y),
      ],
    };
    manifest.gaze.cellWidth = Math.round(left.width) + Math.round(right.width);
    manifest.gaze.cellHeight = Math.round(Math.max(left.height, right.height));
  } catch {
    // The smile can still preview if the landmark file is not written yet.
  }
}

function publishLocalBundles(inner: FaceStore): FaceStore {
  return {
    ...inner,
    async writeManifest(faceId) {
      await inner.writeManifest(faceId);
      const manifest = await inner.readManifest(faceId);
      if (manifest && typeof manifest === "object") {
        const stamped = manifest as Manifest;
        await stampEyes(faceId, stamped);
        const version = Date.now();
        const bust = (file: string) => `${file.split("?")[0]}?v=${version}`;
        for (const plate of ["smile", "curious", "pain", "nausea"] as const) {
          const file = stamped.plates[plate];
          if (file) stamped.plates[plate] = bust(file);
        }
        stamped.gaze.sheet = bust(stamped.gaze.sheet);
        const file = path.join(process.cwd(), bundlePath(faceId, "manifest.json"));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(stamped));
      }
      return `${appOrigin()}/faces/${faceId}/manifest.json`;
    },
    async getManifestUrl(faceId) {
      const face = await inner.getFace(faceId);
      if (!face?.smilePath) return undefined;
      return `${appOrigin()}/faces/${faceId}/manifest.json`;
    },
  };
}

const storeGlobal = globalThis as typeof globalThis & {
  __expressionsFaceStore?: FaceStore;
};
const sharedFaceStore =
  storeGlobal.__expressionsFaceStore ??
  (storeGlobal.__expressionsFaceStore = publishLocalBundles(createInMemoryFaceStore()));

function isFaceModelMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("Face landmarker model is absent");
}

function defaultDeps(overrides?: Partial<FaceApiDeps>): FaceApiDeps {
  const store = overrides?.store ?? sharedFaceStore;
  const deps: FaceApiDeps = {
    store,
    readRecipe: () => {
      const recipePath = path.join(process.cwd(), "recipes", "v1.json");
      try {
        return readFileSync(recipePath, "utf8");
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: string }).code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      }
    },
    parseRecipe,
    baseUrl:
      process.env.NEXT_PUBLIC_APP_ORIGIN?.replace(/\/$/, "") ??
      (process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3456"),
    prepare: async (bytes, mediaType, faceId) => {
      try {
        const detect = createMediaPipeDetector();
        const cropped = await cropToSmile(
          { bytes: new Uint8Array(bytes), mediaType },
          detect,
        );
        if (!cropped.ok) {
          return { ok: false, error: cropped.rejection.code };
        }
        const smileRel = bundlePath(faceId, "smile.webp");
        const smileAbs = path.join(process.cwd(), smileRel);
        await mkdir(path.dirname(smileAbs), { recursive: true });
        await sharp(Buffer.from(cropped.image.data), {
          raw: {
            width: cropped.image.width,
            height: cropped.image.height,
            channels: 4,
          },
        })
          .webp()
          .toFile(smileAbs);
        const sourceRel = sourcePath(faceId);
        const sourceAbs = path.join(process.cwd(), sourceRel);
        await mkdir(path.dirname(sourceAbs), { recursive: true });
        await writeFile(sourceAbs, bytes);
        await writeSmileLandmarks(faceId, cropped.landmarks);
        return { ok: true, smilePath: smileRel };
      } catch (error) {
        if (isFaceModelMissingError(error)) {
          return { ok: false, error: "face_model_missing" };
        }
        throw error;
      }
    },
    rateLimit: new IpRateLimiter(10, 60_000),
    newFaceId: () => randomBytes(16).toString("hex"),
    runWorker: async ({ faceId, apiKey, plates }) => {
      console.error(`[expressions] worker start ${faceId}`);
      const recipeBody = deps.readRecipe();
      if (!recipeBody) {
        console.error(`[expressions] worker ${faceId} recipe missing`);
        return;
      }
      const recipe = deps.parseRecipe(JSON.parse(recipeBody));
      const client = createLiveMagicHourClient(apiKey);
      const persister = createPlatePersister({
        faceId,
        detect: createMediaPipeDetector(),
      });
      const lockToken = randomBytes(16).toString("hex");
      await runFace({
        faceId,
        store: deps.store,
        client,
        recipe,
        apiKey,
        lockToken,
        plates,
        saveImage: persister.saveImage,
        finalizeGroup: persister.finalizeGroup,
      });
    },
    createClient: createMagicHourClient,
    ...overrides,
  };
  if (overrides?.store) {
    deps.store = overrides.store;
  }
  return deps;
}

function recipeCheck(
  deps: FaceApiDeps,
): { ok: true; recipe: Recipe } | { ok: false; response: Response } {
  try {
    assertRecipePresent(deps.readRecipe);
  } catch {
    return { ok: false, response: json({ error: "recipe_missing" }, 409) };
  }
  const body = deps.readRecipe();
  if (!body) {
    return { ok: false, response: json({ error: "recipe_missing" }, 409) };
  }
  return { ok: true, recipe: deps.parseRecipe(JSON.parse(body)) };
}

function isPlateGroup(value: string): value is PlateGroup {
  return (PLATE_GROUPS as readonly string[]).includes(value);
}

export function createFaceHandlers() {
  return {
    async postFaces(request: Request, deps: FaceApiDeps = defaultDeps()): Promise<Response> {
      if (!deps.rateLimit.allow(clientIp(request))) {
        return json({ error: "rate_limited" }, 429);
      }

      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return json({ error: "invalid_form" }, 400);
      }

      const likeness = form.get("likeness");
      if (likeness !== "yes") {
        return json({ error: "likeness_required" }, 400);
      }

      const mediaType = form.get("mediaType");
      const file = form.get("file");
      if (typeof mediaType !== "string" || !(file instanceof Blob)) {
        return json({ error: "invalid_form" }, 400);
      }

      const apiKey = bearerKey(request);
      if (!apiKey) {
        return json({ error: "unauthorized" }, 401);
      }

      const recipeOutcome = recipeCheck(deps);
      if (!recipeOutcome.ok) {
        return recipeOutcome.response;
      }

      const bytes = Buffer.from(await file.arrayBuffer());
      const id = deps.newFaceId();
      const prepared = await deps.prepare(bytes, mediaType, id);
      if (!prepared.ok) {
        return json({ error: prepared.error }, 400);
      }
      await deps.store.createFace({
        id,
        sourcePath: sourcePath(id),
        smilePath: prepared.smilePath,
        likenessAt: new Date(),
      });
      await deps.store.writeManifest(id);

      void deps.runWorker({ faceId: id, apiKey }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "worker failed";
        console.error(`[expressions] worker ${id} ${message}`);
      });

      return json({ id }, 200);
    },

    async getFace(
      _request: Request,
      context: { params: { id: string } },
      deps: FaceApiDeps = defaultDeps(),
    ): Promise<Response> {
      const face = await deps.store.getFace(context.params.id);
      if (!face) return notFound();

      const plateRows = await deps.store.listPlates(face.id);
      const plates = Object.fromEntries(
        plateRows.map((row) => [row.plate, row.status]),
      ) as Record<PlateGroup, PlateStatus>;

      const manifestUrl = face.smilePath
        ? await deps.store.getManifestUrl(face.id)
        : undefined;

      return json(
        {
          id: face.id,
          status: face.status,
          plates,
          ...(manifestUrl ? { manifestUrl } : {}),
        },
        200,
      );
    },

    async postRetry(
      request: Request,
      context: { params: { id: string } },
      deps: FaceApiDeps = defaultDeps(),
    ): Promise<Response> {
      const face = await deps.store.getFace(context.params.id);
      if (!face) return notFound();

      const apiKey = bearerKey(request);
      if (!apiKey) {
        return json({ error: "unauthorized" }, 401);
      }

      const recipeOutcome = recipeCheck(deps);
      if (!recipeOutcome.ok) {
        return recipeOutcome.response;
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      const plate =
        typeof body === "object" &&
        body !== null &&
        "plate" in body &&
        typeof (body as { plate: unknown }).plate === "string"
          ? (body as { plate: string }).plate
          : "";
      if (!isPlateGroup(plate)) {
        return json({ error: "invalid_plate" }, 400);
      }

      const row = await deps.store.getPlate(face.id, plate);
      if (!row) return notFound();
      if (row.attempts >= RETRY_BUDGET[plate]) {
        return json({ error: "retry_budget" }, 409);
      }

      await deps.store.updatePlate(face.id, plate, { status: "queued" });
      void deps.runWorker({ faceId: face.id, apiKey, plates: [plate] });

      return json({ ok: true }, 200);
    },

    async postAccept(
      _request: Request,
      context: { params: { id: string } },
      deps: FaceApiDeps = defaultDeps(),
    ): Promise<Response> {
      const face = await deps.store.getFace(context.params.id);
      if (!face) return notFound();

      if (!face.smilePath) {
        return json({ error: "not_ready" }, 409);
      }

      const pain = await deps.store.getPlate(face.id, "pain");
      const nausea = await deps.store.getPlate(face.id, "nausea");
      if (pain?.status !== "ready" || nausea?.status !== "ready") {
        return json({ error: "not_ready" }, 409);
      }

      const manifestUrl = await deps.store.getManifestUrl(face.id);
      if (!manifestUrl) {
        await deps.store.writeManifest(face.id);
      }
      const url = (await deps.store.getManifestUrl(face.id)) ?? "";
      await deps.store.updateFace(face.id, { status: "accepted" });

      const snippet =
        `<script src="${deps.baseUrl}/face.js" async></script>` +
        `<expressions-face src="${url}" alt="face"></expressions-face>`;

      return json({ snippet }, 200);
    },

    async deleteFace(
      _request: Request,
      context: { params: { id: string } },
      deps: FaceApiDeps = defaultDeps(),
    ): Promise<Response> {
      const face = await deps.store.getFace(context.params.id);
      if (!face) return notFound();

      await deps.store.deleteSource(face.id);
      await deps.store.deleteBundle(face.id);
      await deps.store.deleteFace(face.id);

      return new Response(null, { status: 204 });
    },

    async postAdvance(
      request: Request,
      context: { params: { id: string } },
      deps: FaceApiDeps = defaultDeps(),
    ): Promise<Response> {
      if (!deps.rateLimit.allow(clientIp(request))) {
        return json({ error: "rate_limited" }, 429);
      }

      const face = await deps.store.getFace(context.params.id);
      if (!face) return notFound();

      const apiKey = bearerKey(request);
      if (!apiKey) {
        return json({ error: "unauthorized" }, 401);
      }

      const recipeOutcome = recipeCheck(deps);
      if (!recipeOutcome.ok) {
        return recipeOutcome.response;
      }

      const rows = await deps.store.listPlates(face.id);
      const pending = rows
        .filter((row) => row.status !== "ready")
        .map((row) => row.plate);

      if (pending.length === 0) {
        return json({ ok: true }, 200);
      }

      void deps.runWorker({ faceId: face.id, apiKey, plates: pending });

      return json({ ok: true }, 200);
    },
  };
}

export { runFace, defaultDeps };
