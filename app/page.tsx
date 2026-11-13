import { Frame } from "./chrome";
import UploadForm from "./upload-form";

export default function Page() {
  return (
    <Frame lede="Turn a single image into something expressive.">
      <UploadForm>
        <expressions-face
          className="demo-face"
          src="/demo/manifest.json"
          alt="Demo face"
        />
      </UploadForm>
    </Frame>
  );
}
