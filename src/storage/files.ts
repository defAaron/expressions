import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { get, put } from "@vercel/blob";

export async function readAsset(key: string): Promise<Buffer> {
  if (!process.env.VERCEL) return readFile(key);
  const object = await get(key, { access: "private", useCache: false });
  if (!object?.stream) throw new Error("Missing face asset");
  return Buffer.from(await new Response(object.stream).arrayBuffer());
}

export async function writeAsset(key: string, bytes: Buffer | string) {
  if (process.env.VERCEL) {
    await put(key, bytes, { access: "private", allowOverwrite: true, addRandomSuffix: false });
    return;
  }
  await mkdir(path.dirname(key), { recursive: true });
  await writeFile(key, bytes);
}
