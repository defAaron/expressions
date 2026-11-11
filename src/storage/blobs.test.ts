import { describe, expect, it } from "vitest";
import {
  blobAccess,
  bundlePath,
  cacheControl,
  sourcePath,
} from "./blobs";

describe("sourcePath", () => {
  it("returns the private source path for a face id", () => {
    expect(sourcePath("abc123")).toBe("private/faces/abc123/source");
  });
});

describe("bundlePath", () => {
  it("returns the public bundle path", () => {
    expect(bundlePath("face-1", "manifest.json")).toBe(
      "public/faces/face-1/manifest.json",
    );
  });

  it("rejects path traversal in file", () => {
    expect(() => bundlePath("face-1", "../secret")).toThrow();
    expect(() => bundlePath("face-1", "foo/../bar")).toThrow();
  });

  it("rejects file names that start with /", () => {
    expect(() => bundlePath("face-1", "/manifest.json")).toThrow();
  });
});

describe("blobAccess", () => {
  it("marks source paths private", () => {
    expect(blobAccess("private/faces/id/source")).toBe("private");
  });

  it("marks bundle paths public", () => {
    expect(blobAccess("public/faces/id/manifest.json")).toBe("public");
  });

  it("throws for unrecognized paths", () => {
    expect(() => blobAccess("other/path")).toThrow();
  });
});

describe("cacheControl", () => {
  it("uses private, no-store for source paths", () => {
    expect(cacheControl("private/faces/id/source")).toBe("private, no-store");
  });

  it("uses immutable public caching for bundle paths", () => {
    expect(cacheControl("public/faces/id/plate.png")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("throws for unrecognized paths", () => {
    expect(() => cacheControl("unknown")).toThrow();
  });
});
