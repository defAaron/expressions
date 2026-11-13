"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { MAX_UPSCALE } from "../src/locker/types";
import { KeyField, UploadIcon } from "./chrome";
import CropFrame, { cropImageFile, type CropSelection } from "./crop-frame";

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 15 * 1024 * 1024;

const UPLOAD_REASONS: Record<string, string> = {
  "unsupported-type": "Choose a PNG, JPG, or WEBP image.",
  "too-large": "Choose an image smaller than 15 MB.",
  "decode-failed": "Upload could not be decoded.",
  "no-face": "No face found.",
  "multiple-faces": "More than one face found.",
  "eyes-not-visible": "Both eyes need to be visible.",
  "upscale-too-large": `Face is too small to fill 1024 without upscaling past ${MAX_UPSCALE}×.`,
  unauthorized: "Paste a Magic Hour API key.",
  likeness_required: "Confirm this is your face, or that you have the right to use it.",
  rate_limited: "Too many uploads. Wait a minute and try again.",
  recipe_missing: "Generation is not ready yet.",
  face_model_missing: "The face checker is not available.",
  invalid_form: "That upload could not be read.",
};

function mediaTypeForFile(file: File): string | null {
  if (ACCEPTED_TYPES.has(file.type)) return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

function reasonFor(code: string): string {
  return UPLOAD_REASONS[code] ?? "Upload failed.";
}

export default function UploadForm({ children }: { children?: ReactNode }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [apiKey, setApiKey] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [likeness, setLikeness] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [cropReady, setCropReady] = useState(false);
  const [applying, setApplying] = useState(false);
  const fileRef = useRef<File | null>(null);
  const cropSelectionRef = useRef<CropSelection | null>(null);
  const requestId = useRef(0);
  const applyingRef = useRef(false);

  fileRef.current = file;

  const canSubmit =
    likeness && file !== null && apiKey.trim().length > 0 && !submitting;

  const onCropSelection = useCallback((selection: CropSelection) => {
    cropSelectionRef.current = {
      imageWidth: selection.imageWidth,
      imageHeight: selection.imageHeight,
      rect: {
        x: selection.rect.x,
        y: selection.rect.y,
        width: selection.rect.width,
        height: selection.rect.height,
      },
    };
    setCropReady(true);
  }, []);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pickFile = useCallback((next: File | null) => {
    requestId.current += 1;
    applyingRef.current = false;
    cropSelectionRef.current = null;
    setApplying(false);
    setCropReady(false);
    setCropping(false);
    if (!next) {
      setFile(null);
      return;
    }
    const mediaType = mediaTypeForFile(next);
    if (!mediaType) {
      setError("Choose a PNG, JPG, or WEBP image.");
      setFile(null);
      return;
    }
    if (next.size > MAX_BYTES) {
      setError("Choose an image smaller than 15 MB.");
      setFile(null);
      return;
    }
    setError(null);
    setFile(next);
  }, []);

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    pickFile(event.target.files?.[0] ?? null);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    pickFile(event.dataTransfer.files?.[0] ?? null);
  };

  const openPicker = () => {
    if (inputRef.current) inputRef.current.value = "";
    inputRef.current?.click();
  };

  const removeImage = () => {
    requestId.current += 1;
    applyingRef.current = false;
    cropSelectionRef.current = null;
    setApplying(false);
    setCropReady(false);
    setCropping(false);
    setFile(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const openCrop = () => {
    if (!fileRef.current || submitting) return;
    cropSelectionRef.current = null;
    setCropReady(false);
    setError(null);
    setCropping(true);
  };

  const cancelCrop = () => {
    requestId.current += 1;
    applyingRef.current = false;
    cropSelectionRef.current = null;
    setApplying(false);
    setCropReady(false);
    setCropping(false);
    setError(null);
  };

  const applyCrop = async () => {
    if (applyingRef.current) return;
    const source = fileRef.current;
    const selection = cropSelectionRef.current;
    if (!source || !selection) return;
    const mediaType = mediaTypeForFile(source);
    if (!mediaType) {
      setError("Choose a PNG, JPG, or WEBP image.");
      return;
    }

    const rect = {
      x: selection.rect.x,
      y: selection.rect.y,
      width: selection.rect.width,
      height: selection.rect.height,
    };
    const view = { width: selection.imageWidth, height: selection.imageHeight };
    applyingRef.current = true;
    setApplying(true);
    const id = ++requestId.current;

    try {
      const result = await cropImageFile(source, mediaType, rect, view);
      if (id !== requestId.current || fileRef.current !== source) return;
      if (!result.ok) {
        setError(reasonFor(result.reason === "too-large" ? "too-large" : "decode-failed"));
        return;
      }
      setError(null);
      cropSelectionRef.current = null;
      setCropReady(false);
      setCropping(false);
      setFile(result.file);
    } catch {
      if (id !== requestId.current || fileRef.current !== source) return;
      setError(reasonFor("decode-failed"));
    } finally {
      if (id === requestId.current) {
        applyingRef.current = false;
        setApplying(false);
      }
    }
  };

  const onSubmit = async () => {
    if (!file || !likeness || apiKey.trim().length === 0) return;
    const mediaType = mediaTypeForFile(file);
    if (!mediaType) {
      setError("Choose a PNG, JPG, or WEBP image.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mediaType", mediaType);
      form.append("likeness", "yes");

      const response = await fetch("/api/faces", {
        method: "POST",
        body: form,
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
      });

      let body: { id?: string; error?: string } = {};
      try {
        body = (await response.json()) as { id?: string; error?: string };
      } catch {
        body = {};
      }

      if (!response.ok) {
        setError(reasonFor(body.error ?? ""));
        return;
      }

      if (typeof body.id === "string") {
        router.push(`/f/${body.id}`);
        return;
      }

      setError("Upload failed.");
    } catch {
      setError("Upload failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="split">
      <section className="panel panel-key">
        <div>
          <h2>Enter your Magic Hour API key</h2>
          <KeyField id="api-key" value={apiKey} onChange={setApiKey} />
        </div>
        {children ? (
          <div className="demo">
            <p>Live demo</p>
            <div className="demo-frame">{children}</div>
          </div>
        ) : null}
      </section>

      <section className="panel panel-upload">
        <h2>Upload an image</h2>
        <ul className="upload-requirements">
          <li>JPEG, PNG, or WebP, 15 MB or smaller</li>
        </ul>
        <input
          ref={inputRef}
          id="image-upload"
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={onFileInput}
        />

        {previewUrl ? (
          <div
            className={cropping ? "preview is-cropping" : "preview"}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setDragOver(false);
            }}
            onDrop={onDrop}
          >
            {cropping ? (
              <CropFrame key={previewUrl} src={previewUrl} disabled={applying} onSelection={onCropSelection} />
            ) : (
              <img src={previewUrl} alt="Uploaded preview" />
            )}
            <div className="preview-bar">
              <div className="preview-name">
                <p>{file?.name}</p>
                <span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : ""}</span>
              </div>
              <div className="preview-actions">
                {cropping ? (
                  <>
                    <button
                      type="button"
                      className="crop-apply"
                      onClick={() => void applyCrop()}
                      disabled={!cropReady || applying || submitting}
                    >
                      Apply crop
                    </button>
                    <button type="button" className="crop-cancel" onClick={cancelCrop}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="crop-open" onClick={openCrop} disabled={submitting}>
                    Crop
                  </button>
                )}
                <button type="button" className="replace" onClick={openPicker}>
                  Replace
                </button>
                <button type="button" className="remove" onClick={removeImage}>
                  Remove
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div
            className={dragOver ? "dropzone is-dragging" : "dropzone"}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setDragOver(false);
            }}
            onDrop={onDrop}
          >
            <span className="upload-badge">
              <UploadIcon />
            </span>
            <strong>Drop your image here</strong>
            <button type="button" className="browse" onClick={openPicker}>
              Browse files
            </button>
            {error ? (
              <p role="alert" className="error">
                {error}
              </p>
            ) : null}
          </div>
        )}

        <div className="actions">
          <label className="likeness">
            <input
              type="checkbox"
              checked={likeness}
              onChange={(event) => setLikeness(event.target.checked)}
            />
            <span>I confirm this is my face or I have the right to use this likeness.</span>
          </label>
          <button
            type="button"
            className={submitting ? "submit is-busy" : "submit"}
            disabled={!canSubmit}
            onClick={() => void onSubmit()}
          >
            {submitting ? "Uploading…" : "Submit"}
          </button>
        </div>
        {previewUrl && error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
