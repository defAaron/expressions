import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MagicHourClientLike } from "../worker/run";

const FACE_EDITOR = "https://api.magichour.ai/v1/ai-face-editor";
const IMAGE_EDITOR = "https://api.magichour.ai/v1/ai-image-editor";
const UPLOADS = "https://api.magichour.ai/v1/files/upload-urls";

function scrub(raw: string, apiKey: string): string {
  if (!raw) return "Magic Hour request failed.";
  if (apiKey && raw.includes(apiKey)) return "Magic Hour request failed.";
  return raw.slice(0, 400);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(response: Response): Promise<string> {
  return response.text();
}

export function createLiveMagicHourClient(apiKey: string): MagicHourClientLike {
  const uploads = new Map<string, Promise<string>>();

  async function upload(localPath: string): Promise<string> {
    const existing = uploads.get(localPath);
    if (existing) return existing;
    const pending = uploadFile(apiKey, localPath);
    uploads.set(localPath, pending);
    try {
      return await pending;
    } catch (error) {
      uploads.delete(localPath);
      throw error;
    }
  }

  return {
    async faceEdit({ imageFilePath, sliders }) {
      const filePath = await upload(imageFilePath);
      const body = {
        assets: { image_file_path: filePath },
        style: { enhance_face: false, ...sliders },
      };
      const id = await postProject(apiKey, FACE_EDITOR, body);
      console.info(`[expressions] face editor ${id}`);
      return { projectId: id };
    },

    async imageEdit({ imageFilePath, prompt }) {
      const filePath = await upload(imageFilePath);
      const body = {
        model: "gpt-image-2",
        resolution: "1k",
        image_count: 1,
        assets: { image_file_paths: [filePath] },
        style: { prompt },
      };
      const id = await postProject(apiKey, IMAGE_EDITOR, body);
      console.info(`[expressions] image editor ${id}`);
      return { projectId: id };
    },

    async pollProject(projectId) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const response = await fetch(
          `https://api.magichour.ai/v1/image-projects/${projectId}`,
          { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        const text = await readBody(response);
        if (response.status === 429) {
          await sleep(5000);
          continue;
        }
        if (!response.ok) {
          return {
            status: "error",
            message: scrub(text, apiKey) || `HTTP ${response.status}`,
          };
        }

        let parsed: {
          status?: string;
          downloads?: Array<{ url?: string }>;
          error?: { message?: string } | null;
        };
        try {
          parsed = JSON.parse(text) as typeof parsed;
        } catch {
          return { status: "error", message: "Invalid Magic Hour response." };
        }

        const status = parsed.status?.toLowerCase();
        if (status === "complete") {
          const imageUrl = parsed.downloads?.find(
            (item) => typeof item.url === "string",
          )?.url;
          if (!imageUrl) {
            return {
              status: "error",
              message: "Magic Hour finished without an image.",
            };
          }
          console.info(`[expressions] project ${projectId} complete`);
          return { status: "complete", imageUrl };
        }
        if (status === "error" || status === "canceled") {
          const message = scrub(
            parsed.error?.message || "Magic Hour project failed.",
            apiKey,
          );
          console.info(`[expressions] project ${projectId} ${status}`);
          return { status: "error", message };
        }
        await sleep(3000);
      }
      return { status: "error", message: "Magic Hour project timed out." };
    },
  };
}

async function postProject(
  apiKey: string,
  url: string,
  body: Record<string, unknown>,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await readBody(response);
    if (response.status === 429 && attempt < 2) {
      await sleep(5000);
      continue;
    }
    if (!response.ok) {
      throw new Error(scrub(text, apiKey) || `HTTP ${response.status}`);
    }
    let parsed: { id?: string };
    try {
      parsed = JSON.parse(text) as { id?: string };
    } catch {
      throw new Error("Invalid Magic Hour response.");
    }
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      throw new Error("Magic Hour response missing project id.");
    }
    return parsed.id;
  }
  throw new Error("Magic Hour rate limit.");
}

async function uploadFile(apiKey: string, localPath: string): Promise<string> {
  const abs = path.isAbsolute(localPath)
    ? localPath
    : path.join(process.cwd(), localPath);
  const extension = path.extname(abs).slice(1).toLowerCase() || "webp";
  const response = await fetch(UPLOADS, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items: [{ type: "image", extension }] }),
  });
  const text = await readBody(response);
  if (!response.ok) {
    throw new Error(scrub(text, apiKey) || `HTTP ${response.status}`);
  }
  const parsed = JSON.parse(text) as {
    items?: Array<{ upload_url?: string; file_path?: string }>;
  };
  const item = parsed.items?.[0];
  if (!item?.upload_url || !item.file_path) {
    throw new Error("Magic Hour upload URL missing.");
  }
  const bytes = await readFile(abs);
  const put = await fetch(item.upload_url, {
    method: "PUT",
    body: bytes,
  });
  if (!put.ok) {
    const putText = await readBody(put);
    throw new Error(scrub(putText, apiKey) || `Upload failed HTTP ${put.status}`);
  }
  return item.file_path;
}
