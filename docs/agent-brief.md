# Expressions — brief for a new agent

Written 17 November 2026, from the tree on the `build` branch.

This file is a map of the product and of the code that exists today. Intended behavior lives in [prd.md](./prd.md) and [architecture.md](./architecture.md). If this file and those two disagree about what the product should do, those two win. If this file and the code disagree about what the code does, read the code.

How the build is sequenced lives in `.cursor/skills/orchestrating-the-build/SKILL.md` and `.cursor/skills/orchestrating-the-build/problems.md`. Read those before changing product code.

## What it is

Expressions turns one front-facing photo into a portrait someone can drop on a static page. The visitor sees a smile whose eyes follow the pointer. A drag stretches the skin into a bracing pain face. Letting go springs the skin home and leaves the face looking sick. That interaction is the whole product. It is the thing people saw on [rameerez.com](https://rameerez.com/) and could not reproduce.

v1 leaves out the reference site’s idle theater (yawn, whistle, doze, fly, phantom tug). Blinks stay, because a face that never blinks reads as a photograph.

There are no accounts. A face is an unguessable id. Whoever has `/f/:id` can preview it, accept it, copy the embed, and delete it. The page says that sharing the preview link shares delete access.

The person brings their own Magic Hour API key. Expressions does not ship one and does not keep theirs. The key sits in React state on that document. It is sent as `Authorization: Bearer` on the calls that spend credits, then dropped. It is not written to `localStorage`, the URL, the face row, the manifest, logs, or the embed. A reload starts with an empty field. Finished plates still preview. The next Magic Hour call waits for the key again.

Generation spends their Magic Hour credits. A happy path is 26 Face Editor calls (24 gaze cells and 2 blinks) plus 3 Image Editor calls (curious, pain, nausea). The smile is never sent through Magic Hour.

## The interaction

The portrait sits in the box the page gives it. The stage is larger than the photo by about 0.3 of the plate width, so a stretch can travel into the page. Pull is the displacement divided by the plate width.

| What the visitor does | What they see |
| --- | --- |
| Nothing, pointer off the face | Smile. Eyes saccade toward the pointer on a 5×5 sheet. Cuts are about 60 ms. Pointer within about 0.24 widths of the eyes, or a pointer that has stopped for 250–450 ms, looks forward. Blinks every few seconds, only on the smile. |
| Mouse rests on the face for 120 ms | Curious fades in over 160 ms. A finger does not hover. |
| Grab, pull still ≤ 0.09 | Curious. |
| Grab, pull > 0.09 | Pain, in about 80 ms, for the rest of the drag. Skin under the pointer stays with the pointer. The pull tapers, rubber-bands past 0.6 of the width, and leans the head a little toward the pull. |
| Release under 0.05, or a cancelled pointer | A tap: curious for 350 ms, then smile. A cancel springs the skin home and plays no expression. |
| Release at 0.05 or more | Nausea for `500 + pull × 2200` ms, then smile over 260 ms. Gaze returns only once the smile is fully back. |
| Four real pulls inside 9 seconds | The same nausea plate, held 2.6 s. The counter then resets. |
| Enter, Space, or arrow keys | A short scripted tug. |
| Reduced motion | The skin eases home with no overshoot. Gaze and expression changes still run. The blink loop stops. |
| No WebGL | A 2D canvas still stretches and swaps plates when it can. Otherwise the smile `img` stays. |

Curious, pain, and nausea bring their own eyes. The gaze sheet is drawn only while the smile is the settled face.

## The plates

Every frame is one 1024×1024 canvas. UV `(u, v)` is the same point on the face in every plate. The smile is the cropped upload. Every other plate is the smile with a masked region replaced. Outside that mask the pixels are the smile’s pixels.

| Plate | Source | When it shows |
| --- | --- | --- |
| Smile | Canonical crop. No Magic Hour. | Default, and the face gaze is built on. |
| Curious | Image Editor, one frozen prompt. | Hover, a small grab, a tap. |
| Pain | Image Editor, one frozen prompt. | While the skin is stretched. |
| Nausea | Image Editor, one frozen prompt. | After a real pull is released. |
| Gaze sheet | 24 Face Editor cells, plus the smile’s own eyes as cell 12. | Eye patches on the smile only. |
| Blinks | Two Face Editor calls, half-shut and shut. | Cells 25 and 26 of the same sheet. |

The sheet is one horizontal strip of 27 cells, row-major, x from −1 to +1, y from up to down, then half blink, then shut. Cell 12 is a byte copy of the smile’s eyes, not a generated image. Starting and stopping tracking must not move a lid or a brow.

A person matte, `matte.webp`, is cut from the smile. The widget draws the photograph only where the matte is set, on a white field. The CDN plate files stay the full photo. The spring moves the person. The background stays still. A manifest may omit `matte`; old manifests still parse.

## What a bundle has to satisfy

This is the product. A funny expression that moved the hair, the crop, or the light is a failed plate.

The locker, after every Magic Hour result:

1. Finds one face on the result.
2. Similarity-aligns it onto the smile using the two eye centers and the mouth. The nose is not part of the fit. This absorbs Face Editor’s plan-dependent output size.
3. Rejects the plate if the held-out nose bridge moved more than 2% of the face width.
4. For gaze and blinks, requires each pupil inside its smile eye rect (inset 4 px) and each outer eye corner within 2 px.
5. Masks, then pastes. Gaze and blinks use the two eye rects, feathered about 8 px. Curious, pain, and nausea share one ellipse over the brows, eyes, cheeks, and mouth. Ears, hair, jaw, clothes, and background stay on the smile. Changed pixels outside the mask reject the image before the paste, so a redrawn shirt cannot leave a halo.
6. Rejects a halo along the mask boundary.
7. Cuts gaze and blink patches 1:1 into the sheet. Full-face plates stay 1024×1024.
8. Encodes WebP.

Each generated item is attempted twice inside the worker. Curious, pain, and nausea repeat the same Image Editor prompt on both attempts. Pain does not switch endpoints. After those two attempts the plate is failed. From the preview, pain and nausea can be retried further, up to the budget in the API section.

The widget does not rescale, recrop, or detect faces. It assumes the locker already made the plates agree.

## How a face is made, in this tree

```text
browser key (React state)
        │  Authorization: Bearer, on POST /api/faces
        ▼
POST /api/faces
  rate limit, likeness === "yes", recipe file present
  MediaPipe crop → 1024 smile.webp + landmarks + matte.webp
  private source bytes on disk
  in-memory face row, manifest written
  fire-and-forget worker (the HTTP response returns the id immediately)
        │
        ▼
worker, one lock per face, four Magic Hour calls at a time
  order: curious, pain, nausea, gaze from the center outward, then blinks
  each result → locker → WebP on disk → manifest rewritten
        │
        ▼
/f/:id polls GET /api/faces/:id once a second
  contact sheet, live <expressions-face>, retry, accept, delete
        │
        ▼
accept → snippet: <script src="{origin}/face.js"> + <expressions-face src="{manifest}">
```

The upload page also lets the person frame the photo before submit (`app/crop-frame.tsx`). The server still runs the canonical crop. A bad file is rejected before any credit is spent.

`/f/:id` does not call `POST /api/faces/:id/advance`. The upload request starts one worker that runs the whole queue in that Node process, using the key captured for that request. The key is not stored on the face. Retry sends the key again from the preview tab. The advance route exists and is rate limited; the page does not drive waves with it.

## Where the code lives

| Path | What it is |
| --- | --- |
| `app/page.tsx`, `app/upload-form.tsx`, `app/crop-frame.tsx`, `app/chrome.tsx` | Landing page: demo face, key field, drop, likeness checkbox. |
| `app/f/[id]/page.tsx`, `app/f/[id]/preview.tsx` | Private preview. Polls status, shows plates, retries pain and nausea, accepts, copies the snippet, deletes. |
| `app/layout.tsx` | Loads `/face.js` on every app page. |
| `app/api/faces/` | Thin Next routes. Behavior is in `src/api/faces.ts`. |
| `src/api/faces.ts` | Handlers, in-memory store, rate limit, id generation, local file prepare. |
| `src/worker/run.ts` | Queue, lock, concurrency of 4, two attempts, manifest updates. |
| `src/worker/persist.ts` | Download a Magic Hour image, run it through the locker, write WebP and the gaze sheet. |
| `src/locker/` | Crop, align, mask, composite, sheet cut, person matte. No network. |
| `src/contract/manifest.ts` | Parse and freeze the manifest shape. |
| `src/recipe/recipe.ts` | Parse `recipes/v1.json`. Runtime does not invent prompts or slider values. |
| `src/magic-hour/client.ts` | HTTP client behind an injected fetch, for tests. Scrubs the key out of errors. |
| `src/magic-hour/live.ts` | The client the worker actually calls. Uploads the smile, posts Face Editor or Image Editor, polls the project. |
| `src/magic-hour/recipe-gate.ts` | Generation returns 409 `recipe_missing` when `recipes/v1.json` is absent. |
| `src/storage/blobs.ts` | Path and cache rules: `private/faces/…` is private, `public/faces/…` is public and immutable for a year. |
| `public/face.js` | The embed. One file, no widget build. Tests in `src/widget/face.test.ts`. |
| `public/demo/` | Two static demo bundles. The landing page uses `manifest.json`. |
| `examples/embed.html` | Static page that loads the script and a manifest from absolute URLs. Those URLs are still the `cdn.example.com` placeholders. |
| `examples/two-faces.html` | Two `<expressions-face>` elements, `/demo/manifest.json` and `/demo/manifest-b.json`. |
| `recipes/v1.json` | Frozen gaze sliders, blink sliders, and the three expression prompts. `enhance_face` is false. |
| `scripts/calibrate.ts` | Refuses to run. It exits with “Calibration spend is not confirmed.” Do not invent slider values or call Magic Hour to fill a recipe. |
| `supabase/migrations/001_faces.sql` | Target schema. The running app does not query Supabase. |
| `models/face_landmarker.task`, `models/selfie_segmenter.tflite` | MediaPipe models for crop and the person matte. |
| `docs/prd.md`, `docs/architecture.md` | Product and technical source of truth. |

Dev server: `npm run dev` serves Next.js on port **3456**. Tests: `npm test` (Vitest). Node 22.

## API, as implemented

| Method | Path | Key | What it does |
| --- | --- | --- | --- |
| `POST` | `/api/faces` | Yes | Multipart `file`, `mediaType`, `likeness=yes`. Rate limit 10 per IP per 60s. Rejects before spend. Returns `{ id }`. Starts the worker. |
| `GET` | `/api/faces/:id` | No | `{ id, status, plates, manifestUrl? }`. Unknown id is 404 `not_found`, same as the other id routes. |
| `POST` | `/api/faces/:id/retry` | Yes | Body `{ plate }` where plate is `curious`, `pain`, `nausea`, `gaze`, or `blink`. The preview only offers pain and nausea. |
| `POST` | `/api/faces/:id/accept` | No | Requires a smile on disk and pain and nausea `ready`. Returns `{ snippet }`. |
| `DELETE` | `/api/faces/:id` | No | Deletes the row, the source file, and the bundle. 204. |
| `POST` | `/api/faces/:id/advance` | Yes | Rate limited. Starts the worker for plates that are not `ready`. The preview page does not call this. |

Manual retry budgets, counted in `attempts` on the plate row: curious 2, pain 4, nausea 4, gaze 2, blink 2. The worker adds an attempt for each try. Pain and nausea are one image each, so two internal tries leave room for two presses on the preview. Gaze and blink share one row across many cells, and each cell increments that row.

Upload rejections use the locker codes: `unsupported-type`, `too-large`, `decode-failed`, `no-face`, `multiple-faces`, `eyes-not-visible`, `upscale-too-large`, plus `face_model_missing` if the landmarker file is absent. Accepted types are JPEG, PNG, and WebP, at most 15 MB, one face, both eyes, upscale at most 4×.

Ids are 16 random bytes, hex. The manifest URL is `{origin}/faces/{id}/manifest.json`, which Next serves from `public/faces/{id}/manifest.json`. Plate URLs in that file get a `?v=` cache buster when the manifest is rewritten.

## Widget

`public/face.js` defines `<expressions-face>`. A host page loads the script once and puts one element per face. Several faces on one page are independent. The script fetches the manifest and its images only. It never calls Magic Hour and never sees a key.

Lifecycle: read `src`, show `smile.webp` in an `img`, draw a canvas over it, load the other plates as the manifest lists them, run the loop only while the element is on screen, drop the WebGL context when the document is hidden. A missing plate stays on the smile. A missing gaze cell falls back toward the center.

The mesh is a triangle grid of about 10 source pixels. The membrane is solved coarser and sampled onto that mesh. A grab is a handful about 8.5% of the plate width. The pull spreads about 24% of the plate width through hair and shoulders. Background and the frame stay pinned. With no matte, a head ellipse stands in for the person. The constants at the top of `face.js` are the PRD numbers (0.05 tap, 0.09 pain, 120 ms hover, and the nausea timing).

The landing demo is a real element pointed at `/demo/manifest.json`. That demo manifest lists the smile only. `gaze.webp` is on disk beside it. Curious, pain, and nausea are not in the demo manifest, so the demo smile can track eyes and the generated expressions are what an uploaded face adds.

## What is local, and what the architecture still describes

The running app is a Next.js process with files on disk. These are the gaps between that and the architecture’s deployment picture.

- **Records are in memory.** `createInMemoryFaceStore` is kept on `globalThis` so a hot reload in the same process keeps the map. Restarting the dev server drops every face row. `GET /api/faces/:id` then 404s even if the WebP files are still under `public/faces/` and `private/faces/`. Those two directories are gitignored.
- **Files are local, not Vercel Blob.** `src/storage/blobs.ts` chooses the path and the cache header. `src/api/faces.ts` and `src/worker/persist.ts` write with `fs` under the working directory. Nothing in the request path talks to Blob or Supabase.
- **The SQL migration is the target schema, unused at runtime.** `faces` and `face_plates`, including `likeness_at` and `worker_token`. The in-memory record has the same fields.
- **The pasted key is the generation key.** `docs/architecture.md` matches the code: there is no server `MAGIC_HOUR_API_KEY` on the request path. `.env.example` still lists that name, and `scripts/calibrate.ts` still reads it, then exits before any spend. `problems.md` problem 4 still says the client reads the key from the environment. The architecture and `src/api/faces.ts` are the later decision.
- **Gaze becomes `ready` when at least one cell in the group succeeds.** The architecture says the gaze plate is `ready` once the center 3×3 is locked and then upgrades as outer cells land.
- **`examples/embed.html` still points at `https://cdn.example.com`.** `examples/two-faces.html` uses the local demo paths.

`.env.example` names, empty values only: `MAGIC_HOUR_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY`, `BLOB_READ_WRITE_TOKEN`. Do not put real keys, source photos, or `.env` into git. Logs may contain a face id and a Magic Hour project id. They must not contain the API key, the Authorization header, or image bytes.

## Out of scope

Accounts, billing, a dashboard beyond the private link, idle theater, custom prompts, video, background replacement, a marketplace of faces. One pain plate is enough; the stretch carries the intensity.

## Read next

1. `docs/prd.md` — the visitor-visible behavior and the decisions table.
2. `docs/architecture.md` — stitch contract, locker checks, manifest JSON, widget state machine, API, security.
3. `.cursor/skills/orchestrating-the-build/problems.md` — the ordered build and each done-when line.
4. `public/face.js` and `src/api/faces.ts` — the two files that show how the running app actually behaves.
