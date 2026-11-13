# Expressions — Product Requirements

Status: draft for build
Date: 10 November 2026

## Problem

On 29 October 2026, [@rameerez](https://x.com/rameerez/status/2115858625180946827) posted: “I've redesigned my personal website. You can now play with my face. Please don't pull too much. It hurts.” The site is [rameerez.com](https://rameerez.com/). The post spread, and people started putting the same kind of portrait on their own sites. The posts show the result. They do not show how to make the pictures or how to wire the interaction.

Expressions is that missing path. A person uploads one neutral photo of their face. Magic Hour generates a locked set of expressions. They get a portrait they can drop on a page: the eyes follow the pointer, a drag stretches the face into pain, and letting go snaps it back and leaves it looking sick.

## What the reference actually does

Inspected on rameerez.com on 10 November 2026. The homepage portrait is the interaction. It is a canvas drawn over a still of him smiling. The still remains if the canvas cannot start.

Behavior a visitor can feel:

1. **Eyes follow the pointer.** On the resting smile, only the eyes move. They jump from one look to the next, the way real eyes saccade, and they watch the pointer around the page. When the pointer is on the face, the eyes look forward at the visitor. The eyes blink. Expression photos other than the resting smile bring their own eyes, and tracking pauses while those photos are showing.
2. **A grab stretches the skin.** Pressing on the face and dragging pulls that point of the photo with the pointer. Nearby skin follows. The pull tapers, it has a rubber-band limit, and the head leans a little into the pull. While the skin is stretched he makes a bracing, hurt face.
3. **Release is elastic.** Letting go springs the skin home, with a little overshoot, and it can be caught again while it is still moving. After a real pull he looks dazed. A tap, with almost no travel, is a different reaction from a pull.
4. **Left alone, he is obviously alive.** If the visitor does nothing, short acts rotate: a yawn, a whistle, shifty eyes, an eye roll, dozing off, a phantom hand tugging a cheek, a fly landing on the nose. He said he added these so people would see that the face was not a picture.

His picture set, read from the page, is larger than the joke needs: a smile, an annoyed face, shock, a hurt face, a dizzy face, a deadpan, a four-frame yawn, a two-frame whistle, plus an eye sheet (looks around the compass, half-shut, shut). Every picture of him is the same square, the same crop, the same orange circle and black shirt.

Expressions v1 reproduces the interaction in items 1–3. It leaves the idle theater in item 4 for later. Blinks stay, because a face that never blinks reads as a photograph.

## User and promise

The user is someone with a personal site, a studio page, or a small team page who saw the post and wants their own face to do it.

The promise, in one sitting:

1. Paste their own Magic Hour API key.
2. Upload one front-facing photo.
3. Watch the four expressions and the eye set generate. The credits come off their Magic Hour account.
4. Poke the preview until it feels right.
5. Copy a snippet onto their site.

v1 has no accounts. A face is a private link. Whoever has the link can preview it, embed it, and delete it. Generating or retrying a plate needs the key again, in that tab.

## Magic Hour key

The person brings their own Magic Hour API key. Expressions does not ship one, and it does not keep theirs.

The key is typed into the generator page and held in that document’s memory until the tab closes or the page is reloaded. That is the whole lifetime.

It is not saved across browser sessions. It is not shared with another tab. It is not written anywhere: not to `localStorage`, `sessionStorage`, IndexedDB, the Cache API, or a cookie; not into the URL, the face link, or the embed; not into the database, file storage, logs, or a background job. A reload, a duplicated tab, or a restored session starts with an empty field. Plates that already finished still preview. The next Magic Hour call waits until they paste the key again.

The field does not ask the browser to remember it: `autocomplete="off"`, no `name`, and it is not submitted as a login. The embed on someone else’s site never receives a key.

## v1 interaction

The portrait sits in whatever box the page gives it. The photograph keeps its aspect inside that box. Stretch can travel into empty space around the photo, so the stage is larger than the picture.

### Rest

The default face is the **smile**. While the smile is fully on screen, the eyes follow the pointer around the page.

Tracking uses a 5 by 5 grid of eye poses cut from the smile: left to right and up to down, including the center. The widget picks the cell whose glance direction best matches the pointer, measured from the point between the pupils. Each change is a short cut of about 60 ms. The eyes do not glide. A little stickiness keeps the cell from flickering when the pointer sits on a boundary between two looks.

When the pointer is within about a quarter of the photo width of the eyes, he looks straight at the visitor (the center cell). After the pointer stops moving he holds the look for 250–450 ms, then looks forward again.

A blink plays on its own every few seconds, at an uneven interval: lids down fast, a beat shut, lids up a little slower. Now and then two blinks come close together. An eye jump has a small chance of blinking with it. Blinks play only on the smile.

The center gaze cell is not a Magic Hour image. It is the smile’s own eye pixels, copied. Starting and stopping tracking must not move a single pixel of the lid or the brow.

### Curious

**Curious** is the light reaction, the same job as the reference’s hover face and its grabbed-but-not-yet-stretched face. It plays in three places:

- The pointer is a mouse and it has rested on the face for 120 ms. Curious fades in over 160 ms. A finger does not do this. On a phone a touch is a tap or a grab.
- A grab whose pull is still at or under 0.09 of the photo width. Curious is already the face, or it fades in over 80 ms.
- A tap: pointer up with travel under 0.05 of the photo width. Curious shows for 350 ms.

Curious is a full-face plate, so the gaze sheet turns off while it is showing and stays off until the smile is fully back. When the pointer leaves, he takes about 220 ms to notice, then returns to the smile over 260 ms. A cursor that only grazes the edge does not flicker him into curious.

### Pull

While the pointer is down and the pull passes 0.09 of the photo width:

- The grabbed point of the skin stays under the pointer.
- Surrounding skin follows, less and less with distance, so a long pull becomes a taper.
- Travel past about 0.6 of the photo width compresses, the way a rubber band does. The skin does not follow the pointer forever.
- The whole head leans a small amount toward the pull, pivoting near the base of the neck.
- The expression crossfades to **bracing pain** in about 80 ms and holds for the rest of the drag. Dropping back under 0.09 during the same grab returns to curious, also in about 80 ms.

Pain is one plate: eyes squeezed, brows down, mouth braced. It brings its own eyes. The gaze sheet stays off for the whole grab.

A cursor that is only hovering already catches the skin under it a little. The skin comes along, resists, and slips free. That is not yet a grab, and it does not by itself switch the face to pain.

### Release

On pointer up, the skin springs home. The spring overshoots and settles, and a new grab during the spring catches the skin where it is.

What the face does depends on how far it was pulled, measured as a fraction of the photo width:

- Under 0.05, or the pointer was cancelled rather than released: a tap. Curious for 350 ms. No pain, no nausea. A cancelled pull (a scroll stealing the finger, the window blurring) lets go of the skin and plays no expression.
- 0.05 or more: **nauseous**, cross-eyed, tongue out. It fades in over about 140 ms and holds for `500 + pull × 2200` milliseconds. A short pull is brief. A long pull leaves him sick for a couple of seconds. Then the smile returns over 260 ms, and eye tracking starts again once the smile is fully back.
- Four real pulls (each at least 0.05) inside 9 seconds: the same nausea plate, held for 2.6 seconds. That is the “enough already” beat. The pull counter then resets.

### Touch, keyboard, and reduced motion

- A finger drag that starts on the face pulls it. A drag that starts outside the face scrolls the page.
- The portrait is a button. Enter or Space plays a short tug on one cheek: curious, a small stretch, pain, spring, nausea, smile. Arrow keys tug the nearest cheek a short distance.
- When the visitor has asked for reduced motion, the skin returns with a short ease and no overshoot. Eye tracking and the expression changes still run. The automatic blink loop stops.
- No WebGL, or a phone that takes the WebGL context away: the smile photograph shows. A 2D canvas path still allows the stretch and the expression swap when WebGL is missing and a 2D canvas is available.

## Faces to generate

Every generated image is locked to one canonical plate. Same pixel dimensions, same crop, same background, same lighting, same hair, same clothes. Expression changes live inside the face. The plate outside that region is the visitor’s own pixels.

### Full-face plates

These four are the minimum set. Each one is a complete 1024×1024 image.

| Plate | When it shows | What it must read as |
| --- | --- | --- |
| Smile | Default, and the face eye tracking is built on | A natural smile, looking at the camera. This is the uploaded photo after the canonical crop. Magic Hour does not redraw it. |
| Curious | Mouse resting on the face, a grab that has not stretched yet, and a tap | Brows up, eyes a little wider, mouth slightly open or softly unsure. Same head position as the smile. |
| Pain | While the skin is stretched | Bracing. Eyes tight, brows pulled down, mouth grimacing as if the pull hurts. |
| Nausea | After a real pull is released | Cross-eyed, tongue out, queasy. The joke of the release. |

### Extra frames the interaction needs

The four plates are not enough for the eyes. These are required in v1.

| Frame | Count | What it is |
| --- | --- | --- |
| Gaze grid | 24 generated cells, plus the smile’s own eyes as the center | 5×5 looks. Horizontal and vertical only, both eyes aimed the same way. Each cell is the smile with only the eye regions changed. |
| Half blink | 1 | Lids halfway down, on the smile. |
| Shut blink | 1 | Eyes closed, on the smile. |

A 3×3 grid is too coarse. Across a hero section the eyes would pop from corner to corner. 5×5 is the smallest grid that tracks. A denser compass, closer to the reference, can wait.

Gaze cells and blinks are stored as a sprite sheet of eye patches. The widget draws them over the smile’s eye rectangles, and only while the smile is the face on screen. Every patch is the smile everywhere except the eyes themselves, so swapping a cell moves nothing but the eyes. The rest of the smile never changes between looks.

The widget never draws a raw Magic Hour image. It draws the locked plates. A plate that shifted, rescaled, or redrew the hair cannot be stretched on the same mesh as the smile: the nose would swim under the pointer, and the eye patches would miss the sockets.

Pain and nausea do not get a gaze grid. Their eyes are part of the joke, and tracking through a grimace or a cross-eye would fight it.

### What we do not generate in v1

Yawn frames, whistle frames, a doze sequence, shock as its own plate, an annoyed plate, a deadpan plate, and a second pain intensity. One pain plate is enough because the stretch itself carries the intensity. If pain from the Face Editor sliders does not read as bracing on the calibration set, the pipeline may spend one Image Editor retry on that plate. That retry is still a single pain plate in the bundle.

## Upload rules

The photo is a head-and-shoulders or a tight headshot, one adult face, looking at the camera, eyes and mouth unobstructed, reasonably sharp.

The uploader confirms the photo is their own face, or that they have the right to use that likeness. The product stores the photo to build the bundle and deletes it when the bundle is deleted.

Rejected uploads:

- No face, or more than one face.
- Face turned far enough that both eyes are not usable.
- Face smaller than the crop can fill at 1024×1024 without upscaling past 4×.
- File that is not a JPEG, PNG, or WebP, or larger than 15 MB.

## Consistency bar

This is the product. A generated face that drifts in crop, background, or lighting is a failed face, even if the expression is funny.

A bundle can be published only when all of these hold:

- Smile, curious, pain, and nausea are exactly 1024×1024, and the same UV is the same point on the face in all four.
- The gaze sheet is cut 1:1 from those plates’ eye rectangles. Its center cell is a copy of the smile’s eyes, not a generated image.
- Outside the expression mask, pixels match the canonical smile. Hairline, collar, background, and the circle or rectangle of the original crop do not move.
- The nose bridge, which is not used to line the images up, stays within 2% of the face width of where it sits on the smile. A result that only matches at the eyes and the mouth is rejected.
- Gaze cells change pixels only inside the two eye rectangles, and each pupil still lands inside its rectangle. A blink may extend into the lids and the immediate brow.
- Curious, pain, and nausea may change the eyes, brows, and mouth. They may not change the ears, hair, neck, clothes, or background.
- The person can see all four plates side by side and accept them before an embed link is issued. They can regenerate pain or nausea alone, up to two times each, without redoing the smile or the gaze sheet.

## Flow

1. Land on a page with the live demo face (our own, already generated), a Magic Hour key field, and an upload.
2. Paste a Magic Hour API key. It stays in that page’s memory only.
3. Drop a photo. See the check pass or the reason it failed.
4. Confirm the likeness right.
5. Wait on a progress view. Smile appears immediately, because it is the crop. Curious, pain, nausea, the gaze sheet, and the blinks fill in as each job finishes. Each generation request carries the key and then drops it. A failed plate shows a retry on that plate. A retry with the page still open reuses the key in memory. A retry after a reload asks for the key again.
6. The preview becomes playable as soon as smile, pain, nausea, and the center gaze exist. Curious and the outer gaze cells can arrive after the first poke. Blinks turn on when they arrive.
7. Accept the set. Copy the snippet. The snippet is a script tag and one element. It works on a static HTML page. The snippet contains no key.
8. Delete, from the same private link, removes the bundle and the source photo. Delete does not need the key.

## Embed

```html
<script src="https://cdn.example.com/face.js" defer></script>
<expressions-face
  src="https://cdn.example.com/b/abc123/manifest.json"
  alt="Alex, smiling">
</expressions-face>
```

Several faces on one page are independent. Each has its own bundle. The script is loaded once.

The element paints the smile from the first byte, then upgrades to the canvas. A page with JavaScript disabled shows the smile image inside the element.

## Out of scope for v1

- Accounts, teams, billing, and a dashboard beyond the private link.
- The reference’s idle acts: yawn, whistle, doze, fly, phantom cursor, eye-roll routine.
- Choosing your own expressions, prompts, or colors.
- Video, talking photos, and head turns as separate plates.
- Replacing the background. The person’s photo is the plate.
- A marketplace of faces.

## Success

- Someone who has seen the post recognizes the interaction within a few seconds of the preview: the eyes move, a pull hurts, letting go looks sick, and the smile comes back.
- Stacking any generated plate on the smile shows no shift outside the face.
- The snippet works on a blank HTML file with no build step.
- A typical face finishes previewable in under two minutes, and the full set finishes without a manual trip through the Magic Hour dashboard.

## Decisions

These are locked for the docs. Change them in this file if they are wrong.

| Topic | Decision |
| --- | --- |
| Default expression | Smile, with the gaze sheet. |
| Hover | A mouse that has rested on the face for 120 ms fades to curious over 160 ms. Eyes track only on the smile, which is the face whenever the pointer is off him. |
| Grab, not yet stretched | Curious, while the pull is at or under 0.09 of the photo width. |
| Pain | One plate, once the pull passes 0.09, for the rest of that stretch. |
| Tap | Release under 0.05 of the width. Curious for 350 ms. No pain, no nausea. |
| Nausea | Release at 0.05 or more. Holds for 500 ms plus 2200 ms times the pull fraction. Four such pulls inside 9 seconds holds nausea for 2.6 s. |
| Gaze | 5×5 on the smile only, plus half-blink and shut. Changes are 60 ms cuts. The center cell is copied from the smile, not generated. |
| Smile source | The cropped upload. It is not regenerated. |
| Canvas | 1024×1024 for every frame. |
| Who can embed | Anyone with the unguessable bundle link. The embed has no key in it. |
| Magic Hour key | The person pastes their own. It lives in that page’s memory until the document is closed or reloaded. It is not saved for another session, another tab, or anywhere else. |
| Idle theater | Later. Blinks stay in v1. |

## Later, if the v1 joke lands

- Idle acts, starting with a yawn and a blink-and-look-away, using the same plate locker.
- A denser gaze grid.
- A second pain plate so a harder pull looks worse.
- Accounts, so a person can keep more than one face and rotate a link if it leaks.
