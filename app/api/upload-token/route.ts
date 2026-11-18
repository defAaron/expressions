import { handleUpload } from "@vercel/blob/client";
import { MAX_UPLOAD_BYTES } from "@/src/locker/types";

export async function POST(request: Request) {
  if (!request.headers.get("authorization")?.startsWith("Bearer ")) return new Response(null, {status: 401});
  try {
    const result = await handleUpload({
      request, body: await request.json(),
      onBeforeGenerateToken: async pathname => {
        if (!/^incoming\/[a-f0-9-]{36}$/.test(pathname)) throw new Error("Invalid upload path");
        return { allowedContentTypes: ["image/jpeg","image/png","image/webp"], maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: false, validUntil: Date.now() + 600000, ttlDays: 1 };
      },
    });
    return Response.json(result);
  } catch { return Response.json({error: "invalid_upload"}, {status: 400}); }
}
