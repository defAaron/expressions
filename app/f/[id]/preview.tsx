"use client";

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

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type PlateStatus = "queued" | "running" | "ready" | "failed";

type FacePayload = {
  id: string;
  status: string;
  plates: Record<string, PlateStatus>;
  manifestUrl?: string;
};

const PLATE_LABELS = [
  "smile",
  "curious",
  "pain",
  "nausea",
  "gaze",
  "blink",
] as const;

export default function Preview({ faceId }: { faceId: string }) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [face, setFace] = useState<FacePayload | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/faces/${faceId}`);
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setPollError(body.error ?? "not_found");
        setFace(null);
        return;
      }
      const body = (await response.json()) as FacePayload;
      setFace(body);
      setPollError(null);
    } catch {
      setPollError("status_unavailable");
    }
  }, [faceId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [load]);

  const bearerHeaders = (): Headers => {
    const headers = new Headers({ "Content-Type": "application/json" });
    const trimmed = apiKey.trim();
    if (trimmed.length > 0) {
      headers.set("Authorization", `Bearer ${trimmed}`);
    }
    return headers;
  };

  const retryPlate = async (plate: "pain" | "nausea") => {
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/faces/${faceId}/retry`, {
        method: "POST",
        headers: bearerHeaders(),
        body: JSON.stringify({ plate }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setActionError(body.error ?? "retry_failed");
        return;
      }
      await load();
    } catch {
      setActionError("retry_failed");
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/faces/${faceId}/accept`, {
        method: "POST",
      });
      const body = (await response.json()) as { snippet?: string; error?: string };
      if (!response.ok) {
        setActionError(body.error ?? "accept_failed");
        return;
      }
      if (body.snippet) {
        setSnippet(body.snippet);
      }
      await load();
    } catch {
      setActionError("accept_failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/faces/${faceId}`, { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        const body = (await response.json()) as { error?: string };
        setActionError(body.error ?? "delete_failed");
        return;
      }
      router.push("/");
    } catch {
      setActionError("delete_failed");
    } finally {
      setBusy(false);
    }
  };

  const smileStatus: PlateStatus = face?.manifestUrl ? "ready" : "queued";

  return (
    <main>
      <h1>Preview</h1>
      <p>Face id: {faceId}</p>
      <p>Sharing this preview link shares delete access.</p>

      <label>
        Magic Hour API key
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>

      {pollError ? <p role="alert">{pollError}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      <ul>
        {PLATE_LABELS.map((plate) => {
          const status =
            plate === "smile" ? smileStatus : (face?.plates[plate] ?? "queued");
          return (
            <li key={plate}>
              {plate}: {status}
            </li>
          );
        })}
      </ul>

      {face?.manifestUrl ? (
        <>
          <p>
            Manifest:{" "}
            <a href={face.manifestUrl}>{face.manifestUrl}</a>
          </p>
          <expressions-face src={face.manifestUrl} alt="face" />
        </>
      ) : null}

      <p>
        <button type="button" disabled={busy} onClick={() => void retryPlate("pain")}>
          Retry pain
        </button>{" "}
        <button type="button" disabled={busy} onClick={() => void retryPlate("nausea")}>
          Retry nausea
        </button>{" "}
        <button type="button" disabled={busy} onClick={() => void accept()}>
          Accept
        </button>{" "}
        <button type="button" disabled={busy} onClick={() => void remove()}>
          Delete
        </button>
      </p>

      {snippet ? (
        <label>
          Embed snippet
          <textarea readOnly value={snippet} rows={4} cols={80} />
        </label>
      ) : null}
    </main>
  );
}
