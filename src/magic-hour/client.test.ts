import { describe, expect, it } from "vitest";
import { assertRecipePresent } from "./recipe-gate";
import {
  createMagicHourClient,
  type MagicHourHttp,
} from "./client";

const API_KEY = "secret-key-value";

function collectHttp(
  responses: Array<{ status: number; body: string }>,
): { http: MagicHourHttp; calls: Parameters<MagicHourHttp>[0][] } {
  const calls: Parameters<MagicHourHttp>[0][] = [];
  let index = 0;
  const http: MagicHourHttp = async (request) => {
    calls.push(request);
    const next = responses[index];
    index += 1;
    if (!next) {
      throw new Error("no more mocked responses");
    }
    return next;
  };
  return { http, calls };
}

describe("createMagicHourClient", () => {
  it("faceEdit posts to ai-face-editor with enhance_face false and the key", async () => {
    const { http, calls } = collectHttp([
      { status: 200, body: JSON.stringify({ id: "proj-face" }) },
    ]);
    const client = createMagicHourClient(http, API_KEY);

    const result = await client.faceEdit({
      imageFilePath: "/blob/smile.png",
      sliders: { mouth_smile: 10 },
    });

    expect(result).toEqual({ projectId: "proj-face" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.magichour.ai/v1/ai-face-editor");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(calls[0].body ?? "");
    expect(body.enhance_face).toBe(false);
    expect(body.image_file_path).toBe("/blob/smile.png");
    expect(body).toMatchObject({ mouth_smile: 10 });
  });

  it("imageEdit posts to ai-image-editor", async () => {
    const { http, calls } = collectHttp([
      { status: 200, body: JSON.stringify({ id: "proj-img" }) },
    ]);
    const client = createMagicHourClient(http, API_KEY);

    const result = await client.imageEdit({
      imageFilePath: "/blob/smile.png",
      prompt: "crossed eyes",
    });

    expect(result).toEqual({ projectId: "proj-img" });
    expect(calls[0].url).toBe("https://api.magichour.ai/v1/ai-image-editor");
    const body = JSON.parse(calls[0].body ?? "");
    expect(body.image_file_path).toBe("/blob/smile.png");
    expect(body.prompt).toBe("crossed eyes");
  });

  it("pollProject polls until complete", async () => {
    const { http, calls } = collectHttp([
      { status: 200, body: JSON.stringify({ status: "queued" }) },
      {
        status: 200,
        body: JSON.stringify({
          status: "complete",
          downloads: [{ url: "https://cdn.example/out.png" }],
        }),
      },
    ]);
    const client = createMagicHourClient(http, API_KEY);

    const result = await client.pollProject("proj-1");

    expect(result).toEqual({
      status: "complete",
      imageUrl: "https://cdn.example/out.png",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.magichour.ai/v1/projects/proj-1");
    expect(calls[1].url).toBe("https://api.magichour.ai/v1/projects/proj-1");
  });

  it("redacts the api key from thrown error messages", async () => {
    const http: MagicHourHttp = async () => ({
      status: 500,
      body: `upstream failed for key ${API_KEY}`,
    });
    const client = createMagicHourClient(http, API_KEY);

    await expect(
      client.faceEdit({
        imageFilePath: "/blob/smile.png",
        sliders: {},
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(API_KEY);
      return true;
    });
  });
});

describe("assertRecipePresent", () => {
  it("throws when the recipe is missing", () => {
    expect(() => assertRecipePresent(() => undefined)).toThrow(
      "Recipe is missing.",
    );
  });

  it("does not throw when the recipe string is present", () => {
    expect(() => assertRecipePresent(() => '{"version":1}')).not.toThrow();
  });
});
