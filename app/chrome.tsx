"use client";

import { useState, type ReactNode } from "react";

type FaceElementProps = React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLElement> & { src?: string; alt?: string },
  HTMLElement
>;

declare global {
  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        "expressions-face": FaceElementProps;
      }
    }
  }
}

type FaceMood = "happy" | "wink" | "surprised" | "sad" | "playful" | "calm";

function KeyIcon() {
  return (
    <svg
      aria-hidden="true"
      className="key-icon"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="m10 13 8.5-8.5M15 8l2 2M17 6l2 2" strokeLinecap="round" />
    </svg>
  );
}

function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path
        d="M2.7 12s3.4-5 9.3-5 9.3 5 9.3 5-3.4 5-9.3 5-9.3-5-9.3-5Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.25" />
      {hidden ? <path d="m4 4 16 16" strokeLinecap="round" /> : null}
    </svg>
  );
}

export function UploadIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path
        d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function OutlineFace({ mood, className }: { mood: FaceMood; className: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 32 32"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="16" cy="16" r="12.5" />
      {mood === "wink" ? <path d="M9.5 12.5H13" /> : <circle cx="11.5" cy="12.5" r=".8" />}
      <circle cx="20.5" cy="12.5" r=".8" />
      {mood === "happy" ? <path d="M10.5 18c1.2 3 3 4.5 5.5 4.5s4.3-1.5 5.5-4.5" /> : null}
      {mood === "wink" ? <path d="M11 18.5c1.4 2.1 3 3.1 5 3.1s3.6-1 5-3.1" /> : null}
      {mood === "surprised" ? <circle cx="16" cy="20" r="2.4" /> : null}
      {mood === "sad" ? <path d="M11.5 22c1.2-2.2 2.7-3.2 4.5-3.2s3.3 1 4.5 3.2" /> : null}
      {mood === "playful" ? (
        <>
          <path d="M10.5 18.5h11c-.8 2.8-2.6 4.2-5.5 4.2s-4.7-1.4-5.5-4.2Z" />
          <path d="M16 20.5v2" />
        </>
      ) : null}
      {mood === "calm" ? <path d="M12 20h8" /> : null}
    </svg>
  );
}

const FOOTER_FACES: { mood: FaceMood; className: string }[] = [
  { mood: "happy", className: "f1" },
  { mood: "surprised", className: "f2" },
  { mood: "wink", className: "f3" },
  { mood: "calm", className: "f4" },
  { mood: "playful", className: "f5" },
  { mood: "sad", className: "f6" },
  { mood: "playful", className: "f7" },
  { mood: "happy", className: "f8" },
  { mood: "wink", className: "f9" },
  { mood: "calm", className: "f10" },
  { mood: "happy", className: "f11" },
  { mood: "sad", className: "f12" },
];

export function KeyField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [showKey, setShowKey] = useState(false);

  return (
    <div className="field">
      <label htmlFor={id}>API key</label>
      <div className="key-box">
        <KeyIcon />
        <input
          id={id}
          type={showKey ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="mhk_live"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="eye"
          onClick={() => setShowKey((current) => !current)}
          aria-label={showKey ? "Hide API key" : "Show API key"}
        >
          <EyeIcon hidden={showKey} />
        </button>
      </div>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="face-field" aria-hidden="true">
        {FOOTER_FACES.map((face) => (
          <OutlineFace key={face.className} mood={face.mood} className={face.className} />
        ))}
      </div>
      <div className="footer-links">
        <a href="https://github.com/magichourhq" target="_blank" rel="noreferrer">
          See GitHub repo
        </a>
        <a href="https://magichour.ai" target="_blank" rel="noreferrer">
          Check out Magic Hour
        </a>
      </div>
    </footer>
  );
}

export function Frame({ lede, children }: { lede: string; children: ReactNode }) {
  return (
    <main className="stage">
      <div className="shell">
        <header className="mast">
          <h1>Expressions</h1>
          <p>{lede}</p>
        </header>
        {children}
        <SiteFooter />
      </div>
    </main>
  );
}
