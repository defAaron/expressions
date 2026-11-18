import { BlobPreconditionFailedError, del, get, list, put } from "@vercel/blob";
import type { FaceRecord, FaceStore, PlateRecord } from "../api/faces";
import { bundlePath, sourcePath } from "./blobs";

type State = { face: FaceRecord; plates: PlateRecord[]; leaseUntil?: number };

const stateKey = (id: string) => `private/faces/${id}/state.json`;

async function readState(id: string) {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const blob = await get(stateKey(id), { access: "private", useCache: false });
  if (!blob?.stream) return null;
  const state: State = await new Response(blob.stream).json();
  return { state, etag: blob.blob.etag };
}

// A worker handles several plates concurrently. Serialize its edits to one face,
// and retain ETag checks for edits made by separate function instances.
const pendingChanges = new Map<string, Promise<boolean>>();

async function change(id: string, update: (state: State) => boolean) {
  const previous = pendingChanges.get(id) ?? Promise.resolve(true);
  const next = previous.catch(() => false).then(() => applyChange(id, update));
  pendingChanges.set(id, next);
  try {
    return await next;
  } finally {
    if (pendingChanges.get(id) === next) pendingChanges.delete(id);
  }
}

async function applyChange(id: string, update: (state: State) => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await readState(id);
    if (!current || !update(current.state)) return false;
    try {
      await put(stateKey(id), JSON.stringify(current.state), {
        access: "private", allowOverwrite: true, ifMatch: current.etag,
      });
      return true;
    } catch (error) {
      const conflict = error instanceof BlobPreconditionFailedError ||
        (error instanceof Error && error.message.includes("conflicting operation"));
      if (!conflict) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * 100));
    }
  }
  throw new Error("Concurrent face updates exceeded retry limit");
}

export function blobFaceStore(origin: string): FaceStore {
  const manifestUrl = (id: string) => `${origin}/faces/${id}/manifest.json`;
  return {
    faces: new Map(),
    async createFace(input) {
      if (!input.id) throw new Error("Missing face ID");
      const face: FaceRecord = { ...input, id: input.id, status: "drafting" };
      const groups = ["curious", "pain", "nausea", "gaze", "blink"] as const;
      const state: State = { face, plates: groups.map(plate => ({ plate, attempts: 0, status: "queued" })) };
      await put(stateKey(face.id), JSON.stringify(state), { access: "private" });
      return face;
    },
    async getFace(id) { return (await readState(id))?.state.face ?? null; },
    async listPlates(id) { return (await readState(id))?.state.plates ?? []; },
    async getPlate(id, group) { return (await this.listPlates(id)).find(p => p.plate === group) ?? null; },
    async updateFace(id, patch) {
      await change(id, state => { Object.assign(state.face, patch); return true; });
    },
    async updatePlate(id, group, patch) {
      await change(id, state => {
        const plate = state.plates.find(p => p.plate === group);
        if (!plate) return false;
        Object.assign(plate, patch);
        return true;
      });
    },
    tryLock(id, token) {
      return change(id, state => {
        if ((state.leaseUntil ?? 0) > Date.now()) return false;
        state.face.workerToken = token;
        state.leaseUntil = Date.now() + 305_000;
        return true;
      });
    },
    async unlock(id, token) {
      await change(id, state => {
        if (state.face.workerToken !== token) return false;
        delete state.face.workerToken;
        delete state.leaseUntil;
        return true;
      });
    },
    getSmileFilePath(id) { return bundlePath(id, "smile.webp"); },
    notePlateAsset() { /* The bundle has deterministic asset names. */ },
    async writeManifest(id) { return manifestUrl(id); },
    async getManifestUrl(id) { return manifestUrl(id); },
    async readManifest() { return undefined; },
    async deleteSource(id) { await del(sourcePath(id)); },
    async deleteBundle(id) {
      const assets = await list({ prefix: `public/faces/${id}/` });
      if (assets.blobs.length) await del(assets.blobs.map(blob => blob.url));
    },
    async deleteFace(id) { await del(stateKey(id)); return true; },
  };
}
