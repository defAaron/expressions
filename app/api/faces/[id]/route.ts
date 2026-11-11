import { createFaceHandlers } from "@/src/api/faces";

const { getFace, deleteFace } = createFaceHandlers();

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  return getFace(request, { params });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  return deleteFace(request, { params });
}
