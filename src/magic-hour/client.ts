export type MagicHourHttp = (request: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; body: string }>;

type MagicHourClient = {
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

function safeMessage(raw: string, apiKey: string): string {
  if (raw.includes(apiKey)) {
    return "Magic Hour request failed.";
  }
  return raw;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function postForProjectId(
  http: MagicHourHttp,
  apiKey: string,
  url: string,
  body: Record<string, unknown>,
): Promise<{ projectId: string }> {
  const response = await http({
    url,
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      safeMessage(response.body || `HTTP ${response.status}`, apiKey),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error(
      safeMessage(response.body || "Invalid Magic Hour response.", apiKey),
    );
  }

  const record = parsed as { id?: string; message?: string };
  if (typeof record.id !== "string") {
    const fallback =
      typeof record.message === "string"
        ? record.message
        : "Magic Hour response missing project id.";
    throw new Error(safeMessage(fallback, apiKey));
  }

  return { projectId: record.id };
}

function pollPayload(
  body: string,
  apiKey: string,
):
  | { kind: "pending" }
  | { kind: "complete"; imageUrl: string }
  | { kind: "error"; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(safeMessage(body || "Invalid Magic Hour response.", apiKey));
  }

  const record = parsed as {
    status?: string;
    message?: string;
    error?: string;
    downloads?: Array<{ url?: string }>;
    image_url?: string;
  };

  const status = record.status?.toLowerCase();
  if (status === "complete") {
    const fromDownloads = record.downloads?.find(
      (item) => typeof item.url === "string",
    )?.url;
    const imageUrl =
      fromDownloads ??
      (typeof record.image_url === "string" ? record.image_url : undefined);
    if (!imageUrl) {
      throw new Error("Magic Hour project completed without an image URL.");
    }
    return { kind: "complete", imageUrl };
  }

  if (status === "error" || status === "failed") {
    const raw =
      (typeof record.message === "string" && record.message) ||
      (typeof record.error === "string" && record.error) ||
      "Magic Hour project failed.";
    return { kind: "error", message: safeMessage(raw, apiKey) };
  }

  return { kind: "pending" };
}

export function createMagicHourClient(
  http: MagicHourHttp,
  apiKey: string,
): MagicHourClient {
  return {
    async faceEdit({ imageFilePath, sliders }) {
      return postForProjectId(http, apiKey, "https://api.magichour.ai/v1/ai-face-editor", {
        image_file_path: imageFilePath,
        enhance_face: false,
        ...sliders,
      });
    },

    async imageEdit({ imageFilePath, prompt }) {
      return postForProjectId(http, apiKey, "https://api.magichour.ai/v1/ai-image-editor", {
        image_file_path: imageFilePath,
        prompt,
      });
    },

    async pollProject(projectId) {
      const url = `https://api.magichour.ai/v1/projects/${projectId}`;

      for (;;) {
        const response = await http({
          url,
          method: "GET",
          headers: authHeaders(apiKey),
        });

        if (response.status < 200 || response.status >= 300) {
          throw new Error(
            safeMessage(response.body || `HTTP ${response.status}`, apiKey),
          );
        }

        const outcome = pollPayload(response.body, apiKey);
        if (outcome.kind === "complete") {
          return { status: "complete", imageUrl: outcome.imageUrl };
        }
        if (outcome.kind === "error") {
          return { status: "error", message: outcome.message };
        }
      }
    },
  };
}
