import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Page from "./page";
import UploadForm from "./upload-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("upload page", () => {
  it("renders the Expressions heading", () => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain("Expressions");
  });

  it("renders the demo face and upload form", () => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain("expressions-face");
    expect(html).toContain('/demo/manifest.json"');
    expect(html).toContain("Demo face");
    expect(html).toContain('type="file"');
    expect(html).toMatch(/disabled=""/);
  });

  it("lists image requirements under the upload heading", () => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain("Upload an image");
    expect(html).toContain("JPEG, PNG, or WebP, 15 MB or smaller");
    expect(html).not.toContain("One adult face, looking at the camera");
    expect(html).not.toContain("Head-and-shoulders or a tight headshot");
    expect(html).not.toContain(
      "Eyes and mouth unobstructed, and reasonably sharp",
    );
  });

  it("disables upload until likeness is checked", () => {
    const html = renderToStaticMarkup(<UploadForm />);
    expect(html).toContain('type="button"');
    expect(html).toMatch(/disabled=""/);
    expect(html).not.toMatch(/checked=""/);
  });
});
