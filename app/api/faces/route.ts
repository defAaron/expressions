import { createFaceHandlers } from "@/src/api/faces";

const { postFaces } = createFaceHandlers();

export function POST(request: Request): Promise<Response> {
  return postFaces(request);
}
