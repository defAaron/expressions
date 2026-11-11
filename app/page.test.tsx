import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Page from "./page";

describe("placeholder page", () => {
  it("renders heading Expressions and the upload sentence", () => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain("Expressions");
    expect(html).toContain("Upload arrives in a later step.");
  });
});
