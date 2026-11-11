import Preview from "./preview";

export default async function FacePreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Preview faceId={id} />;
}
