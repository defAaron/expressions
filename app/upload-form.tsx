"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, type ChangeEvent, type DragEvent } from "react";

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function mediaTypeForFile(file: File): string | null {
  if (ACCEPTED_TYPES.has(file.type)) return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

export default function UploadForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [apiKey, setApiKey] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [likeness, setLikeness] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const canSubmit = likeness && file !== null && !submitting;

  const pickFile = useCallback((next: File | null) => {
    if (!next) {
      setFile(null);
      return;
    }
    const mediaType = mediaTypeForFile(next);
    if (!mediaType) {
      setError("Upload must be a JPEG, PNG, or WebP.");
      setFile(null);
      return;
    }
    setError(null);
    setFile(next);
  }, []);

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    pickFile(chosen);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    const dropped = event.dataTransfer.files?.[0] ?? null;
    pickFile(dropped);
  };

  const onSubmit = async () => {
    if (!file || !likeness) return;
    const mediaType = mediaTypeForFile(file);
    if (!mediaType) {
      setError("Upload must be a JPEG, PNG, or WebP.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mediaType", mediaType);
      form.append("likeness", "yes");

      const headers = new Headers();
      if (apiKey.trim().length > 0) {
        headers.set("Authorization", `Bearer ${apiKey.trim()}`);
      }

      const response = await fetch("/api/faces", {
        method: "POST",
        body: form,
        headers,
      });

      let body: { id?: string; error?: string } = {};
      try {
        body = (await response.json()) as { id?: string; error?: string };
      } catch {
        body = {};
      }

      if (!response.ok) {
        setError(body.error ?? "Upload failed.");
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
    <section>
      <label>
        Magic Hour API key
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>

      <div
        role="button"
        tabIndex={0}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        style={{
          border: dragOver ? "2px solid #000" : "2px dashed #999",
          padding: "1.5rem",
          marginTop: "1rem",
          marginBottom: "1rem",
          cursor: "pointer",
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: "none" }}
          onChange={onFileInput}
        />
        {file ? <p>{file.name}</p> : <p>Drop one JPEG, PNG, or WebP here</p>}
        {error ? <p role="alert">{error}</p> : null}
      </div>

      <label>
        <input
          type="checkbox"
          checked={likeness}
          onChange={(event) => setLikeness(event.target.checked)}
        />{" "}
        I confirm this is my face or I have the right to use this likeness.
      </label>

      <p>
        <button type="button" disabled={!canSubmit} onClick={() => void onSubmit()}>
          Upload
        </button>
      </p>
    </section>
  );
}
