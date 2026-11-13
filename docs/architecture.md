# Expressions — Technical Architecture

Status: draft for build
Date: 10 November 2026
Companion: [prd.md](./prd.md)

## Summary

Two systems. A **generator** turns one uploaded photo into a locked bundle of plates. A **widget** plays that bundle: gaze, stretch, pain, elastic return, nausea.

Magic Hour draws the new pixels. It does not guarantee a stable canvas. Face Editor output size follows the subscription, and its sliders cannot cross the eyes or put the tongue out. Image Editor can make those expressions and can also move the hair, the crop, and the light. A **plate locker** runs after every generation and is the thing that makes the frames match.

```text
upload → validate → canonical 1024 plate (the smile)
                         │
                         ├─ Face Editor ─ 24 gazes, 2 blinks
                         └─ Image Editor ─ curious, pain, nausea
                         │
                    plate locker
                      align onto the smile
                      reject if the nose, the sockets, or the background moved
                      paste only the changed region back onto the smile
                      cut the eye rects into one sheet, center cell copied from the smile
                         │
                    bundle on the CDN ← manifest.json
                         │
                    <expressions-face>  one mesh, swap the locked plates
```

The person pastes their own Magic Hour API key into the generator page. The page holds it in memory and sends it with each generation request. The server uses it for that request and does not keep it. The widget is static files plus the bundle. It never calls Magic Hour and never sees a key.

## Stack

| Piece | Choice | Why |
| --- | --- | --- |
| App | Next.js on Vercel | Upload page, job status, preview, and the generation routes in one project. |
| Jobs | One row per face in Postgres (Supabase) | Generation outlives a single HTTP request. The page polls job status. |
| Files | Vercel Blob | Source photo, plates, gaze sheet, manifest. Public read on the bundle, private read on the source. |
| Generator | Magic Hour REST, server-side | `POST /v1/ai-face-editor` and `POST /v1/ai-image-editor`. |
| Widget | One vanilla custom element, no framework | The embed has to work on a static HTML page. |
| Face geometry | MediaPipe Face Landmarker, server-side | Crop, eye rectangles, and the alignment check need landmarks. The browser widget does not detect faces. |

v1 polls Magic Hour for job completion. Webhooks can replace polling later. The [webhook reference](https://docs.magichour.ai/webhook-reference) is the upgrade path, not a v1 dependency.

## Magic Hour, and where each plate goes

Documented behavior we are designing around, from the Magic Hour API reference as of 10 November 2026:

- `POST /v1/ai-face-editor` edits one face with numeric sliders. Each edit costs 1 frame. Sliders run from -100 to 100 in steps of 5. Relevant sliders: `eye_gaze_horizontal`, `eye_gaze_vertical`, `eye_open_ratio`, `eyebrow_direction`, `mouth_smile`, `mouth_grim`, `lip_open_ratio`, `mouth_position_vertical`, `head_pitch`, `head_yaw`, `head_roll`. `enhance_face` stays `false` on every call. There is no tongue slider, and one horizontal gaze value moves both eyes together, so this endpoint cannot make the nausea plate.
- Output width and height for Face Editor follow the account plan. We treat every Face Editor result as an unaligned image and force it onto the 1024 plate.
- `POST /v1/ai-image-editor` takes the source image plus a prompt. The three expression plates use `gpt-image-2` at 1k, from 50 credits each, and this model is not on the free tier. If identity slips in the calibration bake-off, the recipe switches model. The bake-off is a checked-in fixture, not a runtime guess.
- Both endpoints return a project id and `credits_charged`. The image is fetched from the project once its status is complete. Failed projects refund credits on their side. We still record the failure and retry the plate.

### Routing

| Plate | Endpoint | Intent |
| --- | --- | --- |
| Smile | None | Canonical crop of the upload. |
| Curious | Image Editor | Fixed prompt: slightly raised eyebrows, subtly widened eyes, gently parted mouth. |
| Gaze, 24 cells | Face Editor | `eye_gaze_horizontal` and `eye_gaze_vertical` at -100, -50, 0, 50, 100. The center cell is the smile and is not requested. Other sliders stay 0. |
| Half blink, shut | Face Editor | `eye_open_ratio` at two negative steps. The exact steps come from calibration. |
| Pain | Image Editor | Fixed prompt: slightly furrowed eyebrows, narrowed eyes, tension around the nose and mouth. |
| Nausea | Image Editor | Fixed prompt: furrowed eyebrows, narrowed eyes, a wrinkled nose, and a tense downturned mouth. |

Slider signs are not documented as “up” versus “down”. A calibration portrait is committed in the repo. The recipe freezes gaze and blink slider values, and the three expression prompts. Runtime uses the recipe. It does not improvise prompts. The three expression prompts are fixed in the recipe. Pain does not switch endpoints on retry; a retry repeats the same prompt.

Jobs for one face run with bounded parallelism, four at a time, so a gaze sheet does not stampede that person’s Magic Hour account. The open page starts each wave and sends the key again with it. Nothing in the queue holds the key, so a closed or reloaded page stops the wave until they paste it again. Order of usefulness: curious and pain first, then nausea, then gaze from the center outward, then blinks. The preview can start before the outer gaze cells exist. Missing cells fall back to the nearest ready cell, then to the center.

## Magic Hour key

There is no `MAGIC_HOUR_API_KEY` in the server environment. Generation fails closed until the request carries the person’s key.

The generator page keeps the key in a JavaScript variable on that document. One variable, cleared when the document goes away. It is not copied into `localStorage`, `sessionStorage`, IndexedDB, the Cache API, a cookie, the URL, `history`, a `BroadcastChannel`, a `SharedWorker`, or any store another tab or a later visit could read. The input has `autocomplete="off"` and no `name`, and it is not a login form, so the page does not ask the browser to store it.

Calls that spend credits (`POST /api/faces` once generation starts, and `POST /api/faces/:id/retry`, and each follow-up wave while the page is open) require the header `Authorization: Bearer <their key>`. The route reads the header, passes it to the Magic Hour client for the calls made inside that request, and drops it before writing the face row, the plate row, the manifest, or the response. The response body does not echo the key. A missing header on those routes is a 401 and spends nothing.

`GET` status, accept, delete, the preview of finished plates, and the embed do not take the header. Opening the private link in a second tab shows finished work and an empty key field. That tab cannot continue generation until its own field is filled. The first tab’s variable is not visible to it.

Server logs, error reports, and traces record the face id and the Magic Hour project id. They do not record the header. Request-body logging is off for these routes. The database has no column for the key. Blob paths and the manifest have nowhere to put one.

## Stitch contract

The widget binds **one mesh** and swaps textures on it. Magic Hour output is never a texture. Only locker output is. If two plates disagree about where the nose sits, the stretch slides the face under the pointer while the expression crossfades, and the eye patches land off the sockets.

These are the rules a bundle has to satisfy. The widget assumes every one of them and does not rescale, recrop, or re-detect at draw time.

1. **One canvas.** Smile, curious, pain, and nausea are 1024×1024. UV `(u, v)` is the same anatomical point on every plate.
2. **Smile is the plate.** Every other full-face image is the smile with a masked region replaced. Outside that mask the pixels are the smile’s pixels, unchanged.
3. **Eyes are patches, not new portraits.** The gaze sheet is cut from the smile after a gaze edit has been composited onto it. Each cell is the left eye rectangle and the right eye rectangle, side by side, copied 1:1 with no resample. Outside the moving iris and lid, a patch is the smile. Swapping a cell moves nothing but the eyes.
4. **The center cell is a copy.** Cell 12, the forward look, is cut from the smile itself. It is not a Face Editor call with the sliders at zero. A zero-slider call can still redraw the photo, and the eyes would pop the moment tracking starts.
5. **The sheet is the only eye source on the smile.** While the smile is fully showing, the widget draws the eye rectangles from the sheet, including the center cell. That is why rule 4 exists: the sheet and the smile have to be the same pixels there, or the first glance shifts the lids.
6. **Expression plates bring their own eyes.** Curious, pain, and nausea are sampled whole. The gaze sheet is multiplied off as soon as the smile is no longer the settled face, so a pain eye is never drawn on top of a sheet eye.

### Eye rectangles

Measured once, on the smile, before any Magic Hour call.

- Each rect covers the sclera, the lids, and the lower brow, with about 8 pixels of feather room inside the 1024 plate.
- The two rects are expanded so they share one height. Widths stay independent. Expansion is equal above and below the shorter eye.
- Those rects are stored in the manifest in pixels and as fractions of 1024. Every gaze cell and both blinks use them. A later cell does not grow its own rect.
- Sheet layout, left to right, one row: 25 gaze cells in row-major order (x from −1 to +1, y from up to down), then half-blink, then shut. Cell 12 is the copied center. Cell size is `left.width + right.width` by the shared height. The widget blits `[0, 0, left.w, h]` back onto the left rect and `[left.w, 0, right.w, h]` onto the right rect. No scaling.

### What the locker checks

Input: the canonical smile and one Magic Hour result. Output: a 1024×1024 plate, or a gaze patch already cut, or a rejection.

1. **Landmarks on both images.** No single face on the result: reject.
2. **Similarity align.** Scale, rotate, and translate the result so the two eye centers and the mouth center match the smile. This absorbs the plan-dependent Face Editor size. The nose bridge is not part of the fit.
3. **Held-out nose.** After the fit, if the nose bridge is more than 2% of the face width from where it sits on the smile, reject. A head turn or a redraw that only lined up the eyes and the mouth fails here.
4. **Gaze socket.** For a gaze or blink result, each pupil center must land inside that eye’s smile rect, inset by 4 pixels. The outer corner of each eye may move at most 2 pixels. An edit that slid the whole socket would put the iris outside the rect we are about to cut.
5. **Mask, then composite.**
   - Gaze and blinks: the two eye rects, feathered about 8 pixels.
   - Curious, pain, and nausea share one ellipse over the brows, eyes, cheeks, and mouth, tall enough that the smile’s mouth is inside it. Ears, hair, and jawline stay on the smile. Changed pixels that sit outside this mask, beyond the feather, reject the image. Pasting the smile back over a shirt the model redrew would leave a halo, so the reject happens on the aligned result, before the paste.
6. **Paste.** Copy the masked pixels onto the smile. Everything outside the mask is the smile.
7. **Halo.** Along the mask boundary, if the composited image grows an edge the smile does not have, reject. That is a face that was still a few pixels off after the align.
8. **Cut.** Gaze and blink patches are cut from the composited plate, with the smile’s rects, and packed into the sheet. Full-face plates are the composited 1024 image.
9. **Encode.** One WebP setting for every file in the bundle, so a crossfade does not shimmer at the mask edge.

Each generated plate is attempted twice inside the worker (the first call, then one retry). Pain does not switch endpoints on retry. A retry of curious, pain, or nausea repeats that plate’s one prompt. After those two attempts the plate is marked failed. From the preview, the person may regenerate pain or nausea up to two more times each. Those presses spend the same per-plate path and do not rerun the smile or the gaze sheet.

The smile is never sent through Magic Hour. It is the plate the others are glued to, and the source of gaze cell 12.

## Canonical crop

Before any Magic Hour call:

1. Decode the upload, cap the long edge at 2048 for detection, keep the original for the crop.
2. Require one face, both eyes visible, face large enough to fill 1024 without upscaling past 4×.
3. Crop a square centered on the face, with padding above the hair and below the chin so a stretch has skin to pull. The face occupies roughly the middle 55% of the square. Record the crop rectangle.
4. Resize that square to 1024×1024 with a high-quality resample. This file is `smile.webp` and the only pixels the widget will treat as ground truth.
5. Write landmark metadata: left eye rect, right eye rect, point between the pupils, mouth center, all in 1024 space. The widget aims gaze from the pupil point. The locker uses the rects.

The source upload stays in private storage until the bundle is deleted. Magic Hour receives a short-lived URL or an uploaded `file_path` of the canonical smile, so every edit starts from the same pixels.

## Bundle

A bundle is a directory of public files plus a manifest. The manifest is the only URL the embed needs.

```json
{
  "version": 1,
  "size": [1024, 1024],
  "alt": "Alex, smiling",
  "eyes": {
    "left": [310, 340, 150, 110],
    "right": [560, 338, 148, 110],
    "between": [512, 390]
  },
  "plates": {
    "smile": "smile.webp",
    "curious": "curious.webp",
    "pain": "pain.webp",
    "nausea": "nausea.webp"
  },
  "gaze": {
    "sheet": "gaze.webp",
    "cols": 5,
    "rows": 5,
    "cellWidth": 298,
    "cellHeight": 110,
    "order": "row-major, x from -1 to 1, y from up to down, then half blink, then shut",
    "center": 12,
    "half": 25,
    "shut": 26
  }
}
```

Eye rects, the pupil point, and the cell size are pixels on the 1024 plate. `cellWidth` is `left[2] + right[2]`. `cellHeight` is the shared rect height. The widget copies each half of a cell back onto its rect with no scale.

`gaze.webp` is one horizontal strip of 27 cells. Cells 0–24 are the 5×5 grid. Cell 12 is cut from the smile. Cells 25 and 26 are half-blink and shut. One texture bind covers every look and both blinks.

Plates that have not finished are omitted from the manifest. The widget treats a missing plate as “stay on smile”. A missing gaze cell uses the nearest present cell.

Files are immutable and cacheable for a year. A regenerate writes a new directory and a new manifest URL. The old directory can be deleted once the private link points at the new one.

## Widget

`face.js` defines `<expressions-face>`. It is a single file, no build step required for the host page. The app serves it from the CDN.

Lifecycle:

1. Read `src`, fetch the manifest.
2. Show `smile.webp` in an `img` immediately.
3. Create a canvas over the stage. When the first frame draws, hide the img visually and keep it in the document for the no-canvas case.
4. Load pain, nausea, curious, and the gaze sheet as they are listed. A plate that 404s is ignored.
5. Start the loop only while the element is on screen. One draw per frame.
6. On disconnect, or when the document is hidden, stop the loop and drop the WebGL context. If the context is lost, fall back to the img, and try the canvas again the next time the page is shown, up to three times.

### State machine

Pull is the length of the displacement divided by the plate width. The same number drives the face on the reference: under 0.05 is a tap, over 0.09 while still held is the stretched face.

```text
smile ──mouse rests 120ms──► curious ──pointer leaves──► smile
  │
  └──grab, pull ≤ 0.09──► curious
                              │
                     pull > 0.09
                              │
                            pain ──release, pull < 0.05──► curious (350ms) ──► smile
                              │
                     release, pull ≥ 0.05
                              │
                           nausea (500 + pull×2200 ms) ──► smile
```

Four releases with pull ≥ 0.05 inside 9 seconds take the nausea branch and hold it for 2600 ms, then the counter resets. A cancelled pointer (scroll taking the finger, the window blurring) springs the skin home and plays no face.

| State | Plate | Fade | Eyes | Skin |
| --- | --- | --- | --- | --- |
| Smile | smile | 260 ms back from another face | Gaze sheet. 60 ms cuts. Blink every 2.4–6.2 s. Forward look when the pointer is within 0.24 widths of the eyes, and 250–450 ms after the pointer stops. | At rest. A hovering cursor catches the skin lightly and the skin slips free. |
| Curious | curious | 160 ms on hover, 80 ms while grabbed, 140 ms on a tap | The plate’s own eyes. Sheet weight goes to zero. | Hover rub, or a grab whose pull is still ≤ 0.09. |
| Pain | pain | 80 ms | The plate’s own eyes. | Grabbed point stuck to the pointer, falloff, rubber band, small head lean. |
| Nausea | nausea | 140 ms | The plate’s own eyes. | Spring toward rest. |

During a crossfade the mesh is shared. Only the sampled photo changes. v1 crossfades the plates. It does not crossfade the gaze cells: a look change is a cut of about 60 ms, which is how the reference sells a saccade. Optical-flow morphing between plates is a later upgrade.

The gaze sheet is drawn only when the settled face is the smile and the crossfade to it has finished. While a crossfade leaves the smile, the sheet fades out over a few frames so pain’s eyes are the only eyes on screen.

### Mesh

Our own renderer. A regular triangle grid over the plate, cell size about 10 source pixels. Each frame:

- While grabbed, the vertex nearest the grab point is pinned to the pointer, in plate space. Neighbors are pulled with a smooth falloff. The radius of a grab is about 7% of the plate width.
- Pointer travel is passed through a rubber band. Past 0.6 of the plate width, extra travel adds little displacement.
- A slower offset on the whole grid leans the head a few pixels toward the pull.
- On release, each displaced vertex springs home. The spring may overshoot to about 1.15 of the remaining distance on the first bounce, then damps out inside 700 ms. Reduced motion uses a 200 ms ease and no overshoot.
- A grab that begins during the spring pins whatever position the vertices are in at that moment.

The canvas is larger than the photo by a pad of about 0.3 of the plate width, so a taper can leave the photograph and sit on the page. The stage element is that padded box. The host sizes the stage. The photo stays centered at its own aspect.

Drawing uses one textured mesh in the smile’s UV space. Expression crossfade is a mix of two full-plate textures. Gaze is a second sample from the sheet, written only inside the two rects, and only in the settled smile state. The sample is a 1:1 blit of the cell halves. Curious, pain, and nausea sample their own eye pixels from the plate.

### Pointer

- Pointer events on the hit target, which is a real button labeled from the `alt`.
- Mouse over the face shows a grab cursor. During a drag it shows grabbing.
- Touch: the listener is not passive on the face, so a drag that starts on the face does not scroll. A drag that starts outside it does.
- The button’s Enter and Space run a scripted tug: move a point on the cheek out, hold pain, release into nausea, return to smile.
- If a link or another button sits on top of the portrait, that control takes the pointer. The face does not swallow it.

### 2D fallback

If `getContext("webgl")` fails and `getContext("2d")` works, draw the plate into a canvas and apply a simpler displacement to a coarse grid with `drawImage` slices. Expression swaps still run. Gaze still swaps by drawing the eye patches. The head lean can be skipped. If neither context works, the smile `img` stays.

## App API

All routes are on the Next.js app. The widget never holds a Magic Hour key. The generator page holds one in memory, as specified above, and attaches it only to the routes marked **key**.

| Method | Path | Key | Behavior |
| --- | --- | --- | --- |
| `POST` | `/api/faces` | Yes, when generation starts | Multipart upload plus the likeness confirmation. Validates, writes the smile, creates a face row with an unguessable id. Uses the header for the Magic Hour calls in this request, then drops it. Returns the id. |
| `POST` | `/api/faces/:id/advance` | Yes | Generates the next wave of plates for an open page. Same header rule. This is how a long set finishes without a stored key. |
| `GET` | `/api/faces/:id` | No | Status per plate: `queued`, `running`, `ready`, `failed`. Includes the manifest URL once the smile exists. Knowing the id is the capability. |
| `POST` | `/api/faces/:id/retry` | Yes | Body `{ "plate": "pain" \| "nausea" \| "curious" \| "gaze" \| "blink" }`. Reruns that group inside the retry budget. |
| `POST` | `/api/faces/:id/accept` | No | Marks the bundle embeddable and returns the snippet. Requires smile, pain, and nausea `ready`. |
| `DELETE` | `/api/faces/:id` | No | Deletes the row, the source, and the bundle. |

A face row stores: id, status, plate statuses, retry counts, manifest path, source path, created time. No user table, and no key column. The page drives `advance` while it is open. If it goes away, in-flight Magic Hour calls for the current request finish or fail, and no later call is made until a page sends the header again.

The preview page is `/f/:id`. It is the upload result, the plate contact sheet, the live widget pointed at the draft manifest, and the snippet after accept.

Rate limit `POST /api/faces` and `POST /api/faces/:id/advance` by IP. A single face is on the order of 26 Face Editor credits plus three Image Editor calls, billed to the Magic Hour account that owns the pasted key.

## Data

```text
faces
  id            text primary key   -- unguessable
  status        text               -- drafting, ready, accepted, failed
  source_path   text
  manifest_path text
  created_at    timestamptz

face_plates
  face_id       text
  plate         text               -- curious, pain, nausea, gaze, blink
  status        text
  attempts      int
  error         text
  primary key (face_id, plate)
```

Gaze is one row, not 24. The worker owns the cell loop. Individual cell failures retry inside that job. The plate is `ready` when at least the center 3×3 is locked, and `ready` upgrades silently as the outer cells land. The manifest is rewritten each time a cell is added. Manifest writes are last-one-wins on a single worker per face. One worker per face id is the rule. A second invocation no-ops if a worker is already marked active on the row.

## Failure

| Failure | What the user sees |
| --- | --- |
| Upload rejected | The reason, on the drop zone, before any credit is spent. |
| Magic Hour 402 | Generation pauses. The smile preview still works. Status copy says their Magic Hour account needs credits. There is no house key to fall back to. We do not spin. |
| Magic Hour 5xx or a timeout | Retry that plate with backoff, inside the two-attempt budget. |
| Locker rejects alignment | Same as a failed generation. Retry. The attempt counter includes locker rejects. |
| Gaze cell fails, neighbors exist | Widget uses the nearest cell. The contact sheet marks the missing look. |
| Pain or nausea exhausts retries | Preview runs without that plate: a pull then stays on curious or smile, and release skips a missing nausea. The page offers a manual retry. |
| Widget script blocked | The custom element’s child `img`, which the script would have inserted, is absent. Hosts who want a no-JS image put an `img` inside the element. The script leaves an existing child `img` in place until the canvas is live. |

## Cost

Per face, happy path, using published starting prices:

| Work | Calls | Credits, about |
| --- | --- | --- |
| Smile | 0 | 0 |
| 24 gazes, 2 blinks | 26 Face Editor calls | 26 |
| Curious, pain, nausea | 3 Image Editor calls | from 150 |

The happy path is 26 Face Editor credits plus three Image Editor calls, about 180 credits, on the Magic Hour account for the key they pasted. A retry of curious, pain, or nausea is another Image Editor call at that same price. Retries are capped so a bad photo cannot loop. The canonical smile is uploaded once and reused as `image_file_path` for every call.

## Security and likeness

- The Magic Hour key is the person’s, sent per request, and dropped when the request ends. It is not a server environment variable, not a database column, not a file, and not part of the bundle or the embed. See “Magic Hour key” above.
- The source photo is private. Bundle images are public, because an embed has to fetch them from other people’s sites.
- The face id is the secret. It is long and random. Accept, retry, and delete all require it. Do not put the id in a referrer-leaking analytics call on the embed. The embed only receives the manifest URL, which can be a different unguessable path from the management id if we want embeds to stay valid after a management-id rotation. v1 uses one id for both, and documents that sharing the preview link shares delete access. Rotation can split them later.
- The likeness checkbox is stored as a timestamp on the face row. We do not attempt to identify who the person is.
- Logs may contain face ids and Magic Hour project ids. They must not contain the API key, the `Authorization` header, or the image bytes.

## What this document is not

The reference site’s engine is a specific WebGL toy with its own idle script. We are matching the visitor-visible interaction in the PRD. We are not porting that script, its shader, or its idle acts. The mesh, the spring, and the gaze sheet are specified here so they can be written fresh.

## Build order

1. **Locker and fixtures.** Canonical crop, similarity align, the held-out nose check, the gaze-socket check, the mask paste, the halo check, and the 1:1 eye-sheet cut. Tested on still photos before any API spend. The center cell of a fixture sheet must be a byte copy of that fixture’s smile.
2. **Recipe calibration.** Freeze the gaze and blink Face Editor sliders. Curious, pain, and nausea are the fixed Image Editor prompts, not Face Editor slider plates.
3. **Job runner.** Upload route, face rows, parallel plate jobs, manifest writes, preview page with the contact sheet.
4. **Widget.** Smile img, mesh stretch, spring, the four-state machine, gaze sheet, blinks, keyboard tug, reduced motion, 2D fallback.
5. **Embed pass.** A blank HTML file on another origin loads the script and the manifest. Touch on a phone. Two faces on one page.

Step 1 and step 4 can proceed in parallel once the manifest shape above is treated as frozen.
