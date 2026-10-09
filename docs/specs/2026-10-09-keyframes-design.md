# Keyframes: animate an element's position and size

Date: 2026-10-09 · Status: draft for review

## Goal

In the Motion OS player, let the user give one element two keyframes (a box at two moments) so it glides from one to the other. Live projects show the motion for real and can export it without Claude. Every project gets it in the Send to Claude prompt.

## Scope

- Animates position and size only, the same `[x, y, w, h]` box Edit mode already drags. No opacity or rotation.
- At most 2 keyframes per element.
- Easing is always ease in-out (cubic). No easing picker.
- Keyframes add to the element's coded motion; they don't replace it.

## Data

New override path per element, stored with the other edits in `st.over`:

```
"<id>.@keys": [{"t": 2.0, "box": [38, 5, 24, 90]}, {"t": 3.5, "box": [20, 5, 30, 100]}]
```

- `t` is absolute video time in seconds (rounded to 1/fps), `box` is % of frame like `@box`.
- Sorted by `t`. 1 or 2 entries.
- An element has either `@box` (a static move) or `@keys`, never both. Adding the first keyframe turns an existing `@box` into that keyframe's box. Removing all keyframes removes the path.

Box at time `t` (`boxAt(e, t)`):
- No `@keys`: `@box` or the reel.json box, as today.
- 1 keyframe: that box at all times.
- 2 keyframes: hold the first before `t0`, hold the second after `t1`, between them each number goes `a + (b - a) * easeInOut((t - t0) / (t1 - t0))`, with `easeInOut(p) = p < .5 ? 4p³ : 1 - (-2p + 2)³ / 2`.

The element's visible window (`@time`) still controls when it shows. The box function only decides where.

## Player UI (Edit mode)

- **K** key and a ◆ button in the transport: when an element with a `box` is selected and visible, adds a keyframe at the current time with the element's current box. With 2 keyframes already, it replaces the nearer one. Otherwise a toast says to select something on screen first.
- **Dragging** the selected element:
  - playhead on a keyframe (within half a frame): edits that keyframe's box
  - no keyframes: sets `@box`, as today
  - 1 keyframe at another time: adds the second keyframe at the current time
  - 2 keyframes and not on one: no change, and a toast says "Jump to a keyframe to change it"
- **Timeline**: a new row under the scenes, shown when the selected element has keyframes, with a ◆ per keyframe and a line between them. Clicking a ◆ pauses and seeks there.
- **Element card**: a Keyframes section listing each keyframe (time, X, Y, scale %, all editable, plus × to delete it) and Undo to remove them all. It replaces the Size and position section while keyframes exist.
- The scale % label on the selected box keeps working (it reads the box at the current time).

## Preview

- **Live projects**: `liveBoxes()` sends, per edited element, `{"box": [x, y, w, h], "keys": [{t, box}, ...]}` when it has keyframes, and the old `[x, y, w, h, nx, ny, nw, nh]` array when it has only `@box`. `drawGhosts` stays a no-op for live projects.
- **mp4 projects**: the ghost preview (blur the original spot, draw that patch at the new spot) uses `boxAt(e, now())` instead of the static box, so it moves while playing.

## Live renderer contract (projects implement this)

`boxes[id]` is one of:
- `[x, y, w, h, nx, ny, nw, nh]` (unchanged), or
- `{box: [x, y, w, h], keys: [{t, box}, ...]}`, with `t` in absolute video seconds.

`Ed` turns either into a target box for the current frame, then applies the same transform as today: `translate(nx - x %, ny - y %) scale(nw / w)`, `transform-origin: x% y%`. For keys it needs the absolute time, so `Ed` gets the scene's start frame (from a context set where the scene's `<Sequence>` is mounted) and computes `t = (sceneFrom + useCurrentFrame()) / fps`.

Export needs no server change: `boxes` already goes into `$PROPS`.

## Prompt

One line per element with keyframes, under Edits:

```
- [00:02.0 · S1 · Phone] keyframes, ease in-out, [x, y, w, h] in % of frame (src/scenes/S1.tsx:40): 2.0s [38, 5, 24, 90] -> 3.5s [20, 5, 30, 100]
```

A single keyframe reads as a plain size and position edit.

## SKILL.md

- Section 4 "Live projects": document both `boxes` shapes and give an `Ed` example that handles keys (scene start from context, ease in-out, hold before and after).
- Section 6 "Apply feedback": keyframe lines mean "animate this element's box between these two times with ease in-out, on top of its current motion". The element's `box` in reel.json stays the resting (first keyframe) box. After the next version loads, the player drops the sent keyframes, so the animation now lives only in the code and isn't applied twice.

## Herdcats project

Update `herdcats-launch-video/src/lib.tsx` (`Boxes` type, `Ed`, a `SceneStartCtx`) and `Main.tsx` (provide each scene's start frame), then rebuild `motionos-live.js` with esbuild.

## Testing

- Unit-style checks for `boxAt` (0, 1, 2 keyframes; before, between, after; midpoint of ease in-out is the halfway box) in a `selftest()` function on the page, called from the browser console (same idea as `serve.mjs --selftest`). The Herdcats `Ed` math gets the same checks in `src/keys.check.ts`, run with esbuild + node.
- In the browser on the Herdcats project: add 2 keyframes to the phone, scrub and play, check the box overlay and the live render follow; edit a keyframe by dragging and by number field; delete one; Undo; reload and confirm it persisted; check the prompt line.
- Export MP4, then grab frames before, between and after the keyframes with ffmpeg and check the element's position.
- Regression: an element with only a static `@box` still moves and exports as before; an mp4-only project (the qbot-tag example) still previews.
