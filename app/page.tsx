declare global {
  namespace JSX {
    interface IntrinsicElements {
      "expressions-face": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { src?: string; alt?: string },
        HTMLElement
      >;
    }
  }
}

import UploadForm from "./upload-form";

export default function Page() {
  return (
    <main>
      <h1>Expressions</h1>
      <expressions-face src="/demo/manifest.json" alt="Demo face" />
      <UploadForm />
    </main>
  );
}
