import { createFaceHandlers } from "@/src/api/faces";

const { postRetry } = createFaceHandlers();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  return postRetry(request, { params });
}
