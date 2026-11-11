# Ordered problems

This file is part of the `orchestrating-the-build` skill. The order, the write sets, and the done-when lines are binding. Do one ordered problem, then close out. Do not reorder, merge, or pull a later problem forward.

Out of scope in `docs/prd.md` stays out of scope: accounts, billing, idle theater, custom prompts, video, background replacement.

## 1. Scaffold and frozen contract

Done when `npm run dev` serves a placeholder page, `npm test` runs, and the manifest types match the JSON shape in `docs/architecture.md` (1024 size, smile / curious / pain / nausea, gaze sheet of 27 cells, center 12, half 25, shut 26).

Security gate: required.

| Subproblem | Write set | Depends on |
| --- | --- | --- |
| App skeleton, test runner, placeholder page | `package.json`, `package-lock.json`, Next.js and TypeScript config, `app/` | — |
| Secret file hygiene | `.gitignore`, `.env.example` | — |
| Manifest types and a parse test | `src/contract/` | App skeleton |

`.env.example` lists names only: `MAGIC_HOUR_API_KEY`, Supabase URL and key, Blob token. Empty values.

## 2. Plate locker and canonical crop

Done when, with no Magic Hour calls, tests prove: type and size gates (JPEG, PNG, WebP, 15 MB, one face, both eyes, upscale at most 1.5×), 1024 smile crop, similarity align, held-out nose beyond 2% of face width rejects, gaze socket checks, mask paste, halo reject, and a gaze sheet whose center cell is a byte copy of the smile's eyes. Spec: architecture sections "Canonical crop", "Stitch contract", "What the locker checks".

Security gate: required. Untrusted images stay inside the size, type, and decode limits. The locker makes no network call.

| Subproblem | Write set | Depends on |
| --- | --- | --- |
| Locker types | `src/locker/types.ts` | — |
| Canonical crop | `src/locker/crop.ts`, its tests, `package.json` only for the face-landmark dependency | Types |
| Align, nose, socket | `src/locker/align.ts`, its tests | Types |
| Mask geometry | `src/locker/mask.ts`, its tests | Types |
| Paste, halo, sheet cut, center-cell byte copy | `src/locker/composite.ts`, `src/locker/sheet.ts`, their tests | Crop, align, mask |

## 3. Recipe calibration

Done when `recipes/v1.json` is frozen from a real calibration run: Face Editor sliders on a step of 5 within -100..100, `enhance_face` false, fixed nausea prompt, fixed pain-retry prompt, and the locker accepts curious, pain, gaze, blinks, and nausea on the calibration portrait. Runtime reads this file and does not improvise prompts.

Start this problem only after the human has confirmed Magic Hour spend and a calibration portrait is in the repo. If `MAGIC_HOUR_API_KEY` or the portrait is missing, stop, say what to add, and do not invent slider values.

Security gate: required. The key stays in the environment. It is absent from the recipe file, logs, and git.

| Subproblem | Write set | Depends on |
| --- | --- | --- |
| Recipe schema and parser tests | `src/recipe/`, not `recipes/v1.json` | — |
| Calibration run that writes the frozen recipe | `recipes/v1.json`, `scripts/calibrate.ts` | Schema |

## 4. Records, storage, Magic Hour client

Done when face and face_plate records match the architecture "Data" section (including the likeness timestamp and a single-worker lock), source blobs are private, bundle blobs are public, and the Magic Hour client reads the key from the environment, polls a project, and returns errors that do not contain the key. Generation refuses to start when `recipes/v1.json` is missing.

Security gate: required.

| Subproblem | Write set | Depends on |
| --- | --- | --- |
| Schema | `supabase/migrations/` | — |
| Blob paths and cache headers | `src/storage/` | — |
| Server-only Magic Hour client and tests with a mocked HTTP layer | `src/magic-hour/` | — |

## 5. Face API and generation worker

Done when these routes exist and are tested: `POST /api/faces` (rate limited by IP, likeness required, rejection before any credit spend, unguessable id), `GET /api/faces/:id`, `POST /api/faces/:id/retry` (plate enum and the retry budget), `POST /api/faces/:id/accept` (requires smile, pain, and nausea ready), `DELETE /api/faces/:id` (row, source, and bundle). The worker runs one at a time per face, four Magic Hour calls at a time, in the architecture order, two attempts per plate, pain allowed to switch to Image Editor on the second attempt. The manifest updates as plates land. A missing id returns the same not-found for get, retry, accept, and delete.

Security gate: required. This is the full endpoint pass.

| Subproblem | Write set | Depends on |
| --- | --- | --- |
| Routes and rate limit | `app/api/faces/` | — |
| Worker | `src/worker/` | — |

## 6. Upload page and preview page

Done when `/` accepts a drop, shows a rejection reason on the drop zone, and requires the likeness confirmation, and `/f/:id` shows per-plate status, the contact sheet, retry for a failed plate, accept, the embed snippet, and delete. The page may mount `<expressions-face>` before `face.js` exists.

Security gate: required. The browser bundle contains no Magic Hour key. The preview does not send the face id to a third party.

| Subproblem | Write set | Depends on |
| --- | --- | --- |
| Upload page | `app/page.tsx` and its components | — |
| Preview page | `app/f/[id]/` | — |

## 7. Widget

Done when `public/face.js` is the single file an embed loads, with no widget build step, and tests cover the PRD interaction: gaze cuts on the smile only, curious, pain past pull 0.09, tap under 0.05, nausea hold `500 + pull × 2200` ms, four pulls inside 9 seconds, spring, reduced motion, keyboard tug, 2D fallback, and the img fallback.

One subagent owns this problem. `public/face.js` is a single write set.

Security gate: required. The script fetches the manifest and its images only.

## 8. Embed and demo

Done when a static HTML file loads the script and a manifest from absolute URLs, two `<expressions-face>` elements on one page run independently, the landing page shows the demo face plus the upload, and the snippet uses the manifest URL. The page states that sharing the preview link shares delete access.

Security gate: required.

| Subproblem | Write set | Depends on |
| --- | --- | --- |
| Static embed fixture | `examples/embed.html` | — |
| Landing demo and the two-face page | `app/page.tsx`, `examples/two-faces.html` | — |
