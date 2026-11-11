import { createFaceHandlers } from "@/src/api/faces";

const { postAccept } = createFaceHandlers();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  return postAccept(request, { params });
}
