"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Frame, KeyField, OutlineFace } from "../../chrome";

type PlateStatus = "queued" | "running" | "ready" | "failed";

type FacePayload = {
  id: string;
  status: string;
  plates: Record<string, PlateStatus>;
  manifestUrl?: string;
};

const FACE_PLATES = [
  { id: "smile", label: "Smile", mood: "happy" },
  { id: "curious", label: "Curious", mood: "surprised" },
  { id: "pain", label: "Pain", mood: "sad" },
  { id: "nausea", label: "Nausea", mood: "playful" },
] as const;

const EXTRA_PLATES = [
  { id: "gaze", label: "Gaze" },
  { id: "blink", label: "Blink" },
] as const;

const REASONS: Record<string, string> = {
  not_found: "This link does not match a face.",
  status_unavailable: "Status is unavailable right now.",
  unauthorized: "Paste a Magic Hour API key.",
  retry_failed: "That retry did not start.",
  retry_budget: "That plate has used its retries.",
  not_ready: "Smile, pain, and nausea need to finish first.",
  accept_failed: "Accept failed.",
  delete_failed: "Delete failed.",
  invalid_plate: "That plate cannot be retried.",
  recipe_missing: "Generation is not ready yet.",
  rate_limited: "Too many requests. Wait a minute and try again.",
  invalid_json: "That request could not be read.",
};

function explain(code: string | null): string | null {
  if (!code) return null;
  return REASONS[code] ?? "Something went wrong.";
}

export default function Preview({ faceId }: { faceId: string }) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [face, setFace] = useState<FacePayload | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [plateImages, setPlateImages] = useState<Record<string, string>>({});

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
    } finally {
      setLoaded(true);
    }
  }, [faceId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [load]);

  const plateKey = face
    ? [
        face.status,
        face.plates.curious,
        face.plates.pain,
        face.plates.nausea,
        face.plates.gaze,
        face.plates.blink,
      ].join(":")
    : "";

  useEffect(() => {
    if (!face?.manifestUrl) {
      setPlateImages({});
      return;
    }
    let cancelled = false;
    const manifestUrl = face.manifestUrl;
    const base = new URL(manifestUrl, window.location.href);
    void fetch(`${manifestUrl}${manifestUrl.includes("?") ? "&" : "?"}t=${Date.now()}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { plates?: Record<string, unknown> } | null) => {
        if (cancelled || !body?.plates) return;
        const next: Record<string, string> = {};
        for (const plate of FACE_PLATES) {
          const file = body.plates[plate.id];
          if (typeof file === "string" && file.length > 0) {
            const href = new URL(file, base).href;
            next[plate.id] = `${href}${href.includes("?") ? "&" : "?"}t=${Date.now()}`;
          }
        }
        setPlateImages(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [face?.manifestUrl, plateKey]);

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
      if (body.snippet) setSnippet(body.snippet);
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

  const copySnippet = async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const smileStatus: PlateStatus = face?.manifestUrl ? "ready" : "queued";
  const statusFor = (plate: string): PlateStatus =>
    plate === "smile" ? smileStatus : (face?.plates[plate] ?? "queued");

  let body: ReactNode;
  if (!loaded) {
    body = (
      <section className="missing">
        <h2>Opening this face…</h2>
      </section>
    );
  } else if (!face && pollError === "not_found") {
    body = (
      <section className="missing">
        <h2>This link does not match a face.</h2>
        <p>It may have been deleted.</p>
        <a href="/">Start again</a>
      </section>
    );
  } else {
    body = (
      <div className="split">
        <section className="panel panel-key">
          <div>
            <h2>Enter your Magic Hour API key</h2>
            <KeyField id="preview-api-key" value={apiKey} onChange={setApiKey} />
          </div>
          <div className="portrait-slot">
            <p>Preview</p>
            {face?.manifestUrl ? (
              <expressions-face
                key={plateKey}
                className="portrait"
                src={`${face.manifestUrl}${face.manifestUrl.includes("?") ? "&" : "?"}t=${plateKey}`}
                alt="face"
              />
            ) : (
              <div className="waiting">
                <OutlineFace mood="happy" className="glyph" />
                <p>The smile shows up here as soon as the crop finishes.</p>
              </div>
            )}
          </div>
        </section>

        <section className="panel panel-upload">
          <h2>Contact sheet</h2>
          {explain(pollError) ? (
            <p role="alert" className="alert">
              {explain(pollError)}
            </p>
          ) : null}
          {explain(actionError) ? (
            <p role="alert" className="alert">
              {explain(actionError)}
            </p>
          ) : null}

          <ul className="sheet">
            {FACE_PLATES.map((plate) => {
              const status = statusFor(plate.id);
              const image = plateImages[plate.id];
              return (
                <li key={plate.id}>
                  <div className="shot-photo">
                    {image ? <img src={image} alt="" /> : <OutlineFace mood={plate.mood} className="glyph" />}
                    <span className={`pill pill-${status}`}>{status}</span>
                  </div>
                  <div className="shot-foot">
                    <span>{plate.label}</span>
                    {plate.id === "pain" || plate.id === "nausea" ? (
                      status === "failed" ? (
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => void retryPlate(plate.id)}
                        >
                          Retry
                        </button>
                      ) : null
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>

          <ul className="meter">
            {EXTRA_PLATES.map((plate) => {
              const status = statusFor(plate.id);
              return (
                <li key={plate.id}>
                  <span>{plate.label}</span>
                  <span className={`pill pill-${status}`}>{status}</span>
                </li>
              );
            })}
          </ul>

          <div className="action-row">
            <button type="button" className="submit" disabled={busy} onClick={() => void accept()}>
              Accept
            </button>
            <button type="button" className="button-quiet" disabled={busy} onClick={() => void remove()}>
              Delete
            </button>
          </div>

          {snippet ? (
            <div className="snippet">
              <div className="snippet-head">
                <label htmlFor="embed">Embed snippet</label>
                <button type="button" className="button-small" onClick={() => void copySnippet()}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <textarea id="embed" readOnly value={snippet} rows={4} />
            </div>
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <Frame lede="Sharing this preview link shares delete access.">
      {body}
    </Frame>
  );
}
