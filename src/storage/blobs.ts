function assertBundleFile(file: string): void {
  if (file.startsWith("/")) {
    throw new Error("bundle file must not start with /");
  }
  if (file.includes("..")) {
    throw new Error("bundle file must not contain ..");
  }
}

export function sourcePath(faceId: string): string {
  return `private/faces/${faceId}/source`;
}

export function bundlePath(faceId: string, file: string): string {
  assertBundleFile(file);
  return `public/faces/${faceId}/${file}`;
}

export function blobAccess(path: string): "private" | "public" {
  if (path.startsWith("private/faces/")) {
    return "private";
  }
  if (path.startsWith("public/faces/")) {
    return "public";
  }
  throw new Error(`unrecognized blob path: ${path}`);
}

export function cacheControl(path: string): string {
  if (path.startsWith("private/faces/")) {
    return "private, no-store";
  }
  if (path.startsWith("public/faces/")) {
    return "public, max-age=31536000, immutable";
  }
  throw new Error(`unrecognized blob path: ${path}`);
}
