# Keyframes as reel.json data

Date: 2026-10-09 · Status: draft for review

## Problem

When the agent applies keyframe feedback it writes the motion into scene code only. On the next version the player drops the sent keyframe edit (so the motion isn't applied twice), and since nothing in reel.json says the element is animated, the ◆ marks, the Keyframes card section and the moving selection box disappear. The animation is in the video but can no longer be seen or adjusted in the player.

## Goal

Keyframes applied by the agent live in reel.json, so the player always shows and edits them, and live renderers animate them from that data.

## reel.json

An element may carry `keys`: `[{"t": 5.4, "box": [38, 5, 24, 90]}, {"t": 7.8, "box": [38, -74, 45.1, 169]}]`. `t` is render time in seconds; 1 or 2 entries, sorted. `box` stays the element's resting box. `check` validates `keys`: 1–2 entries, sorted `t`, each `t` inside the element's time, each box 4 numbers (keyframe boxes may extend past 0–100, since push-ins do).

## Player

- `elKeys(e)` = the `@keys` override if present, else `e.keys`, else none. Everything that already uses `elKeys` (◆ row, Keyframes card section, box overlay via `elBox`, K, drag) then works for reel keys.
- `setKeys(e, keys)` stores an override only when it differs from `e.keys`: equal to `e.keys` → override removed; empty while `e.keys` exists → stored as `[]` (an explicit "remove this animation"); empty without `e.keys` → removed (today's behaviour).
- `elKeys` returns `null` for an explicit `[]` override, so the element shows its static box.
- The Keyframes section's Undo removes the override (back to the reel keys). When the element has reel keys and no override, the section shows them without the "changed" highlight.
- The prompt/poll row for an edited `@keys` has `from` = the reel keys (`12s [x y w h] -> 14s [...]`) when the element has them, else the static box; `to` = the new keys, or `none (remove the animation)` for `[]`.
- **Live payload** (`liveBoxes`): an element with an `@keys` override sends `{box: e.box, keys: <override>}` (an empty array means static). Elements without an override send nothing; `Ed` reads their reel keys itself.
- **mp4 ghost preview**: for an element with reel keys and an override, the source patch is the box at time t under the reel keys (where the mp4 shows it), the target is the box under the override; with no override, no ghost.

## Live renderer contract (`Ed`)

`Ed` looks up its element's reel.json `keys` (by element id) and, when the player sends `boxes[id]`, uses that instead:
- `boxes[id]` is an 8-number array: static move, as today.
- `boxes[id]` is `{box, keys}`: keys replace the reel keys; `keys: []` means no animation.
- otherwise: the reel keys, if any.

It then computes the target box at absolute time `t` and applies `translate/scale` from `box` as today. Scene code must not animate an element's box itself when that element has `keys`, or the motion is applied twice.

## Applying feedback (SKILL.md)

- Live projects: a `keyframes` edit means set the element's `keys` in reel.json (or remove `keys` for `none`) and re-render. No motion code.
- mp4 projects: implement the motion in code as before **and** record the same `keys` in reel.json, so the player can show it.
- In both cases keep `box` as the resting box.

## Out of scope

Migrating the Herdcats project (its `Ed`, `Hook.tsx` `PHONE_KEYS`, reel.json): the user's other Claude session is doing that.

## Testing

- `check` selftest cases for `keys` (valid, unsorted, 3 entries, `t` outside the element, bad box).
- Player `selftest()`: an element with reel `keys` shows two ◆ and the Keyframes section with no override; `elBox` follows the reel keys; dragging on a reel keyframe creates an override; setting the override back equal to the reel keys removes it; deleting both keyframes stores `[]` and `elBox` returns the static box; the poll row's `from` is the reel keys; `liveBoxes` sends nothing without an override and `{box, keys: []}` for a removal.
- A version-reload check: a sent `@keys` override is dropped on the new version and the element still shows the (new) reel keys.
- `serve`/CLI selftests still pass; qbot-tag example: add `keys` to one element in a temp copy of its reel.json and confirm the ◆ and moving box in the browser.
