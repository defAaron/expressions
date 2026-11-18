import { get } from "@vercel/blob";
import { defaultDeps, defaultManifestSkeleton, stampEyes } from "@/src/api/faces";
import { bundlePath } from "@/src/storage/blobs";

export async function GET(_: Request, context: {params: Promise<{id: string; asset: string}>}) {
  const { id, asset } = await context.params;
  const missing = () => new Response(null, {status: 404});
  if (!process.env.VERCEL || !/^[a-f0-9]{32}$/.test(id)) return missing();
  const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  if (asset === "manifest.json") {
    const { store } = defaultDeps();
    const face = await store.getFace(id);
    if (!face) return missing();
    const manifest = defaultManifestSkeleton(id);
    await stampEyes(id, manifest);
    manifest.plates.smile = "smile.webp";
    if (face.matte) manifest.matte = "matte.webp";
    for (const row of await store.listPlates(id)) {
      if (row.status === "ready" && (row.plate === "pain" || row.plate === "nausea" || row.plate === "curious")) {
        manifest.plates[row.plate] = row.plate + ".webp";
      }
    }
    return Response.json(manifest, {headers});
  }
  if (!/^(smile|matte|pain|nausea|curious|gaze)\.webp$/.test(asset)) return missing();
  const blob = await get(bundlePath(id, asset), {access: "private", useCache: false});
  if (!blob?.stream) return missing();
  return new Response(blob.stream, {headers: {...headers, "Content-Type": "image/webp"}});
}
