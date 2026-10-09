# Scene trim: shorten a scene by dragging its end, later scenes ripple earlier

Date: 2026-10-09 · Status: draft for review

## Goal

On the Motion OS timeline, the user drags a scene's right edge to the left to shorten it. The scene is cut (it plays as before and stops sooner), and every later scene moves earlier to close the gap. The player previews the trimmed edit for both live and mp4-only projects; live projects also export it; Claude gets the trims in the prompt.

## Scope

- Cut, not speed up: the scene's own animation keeps its timing; the tail after the new end is dropped.
- Shorten only. New length is between 0.5s and the scene's original length (`s.t[1] - s.t[0]`), rounded to 1/fps.
- Only the scene's end moves. No trimming the start, no reordering.

## Two clocks

- **Render time** (`src`): the current video's own clock, the one `reel.json` times are in. Everything stored stays in render time: element `t`, `@time`, notes `t`, keyframe `t`, scene `t`. Trims never rewrite them.
- **Edited time** (`ed`): what the viewer watches with cut tails removed.

Per scene `i` (in reel order): original start `S_i = s.t[0]`, original length `O_i`, length `L_i = get('<sid>.@len', O_i)`, edited start `E_i = L_0 + ... + L_(i-1)`. Edited duration `D = sum L_i`.

- `toEd(t)`: scene `i` containing render time `t`; if `t - S_i <= L_i` return `E_i + (t - S_i)`, else (in a cut tail) return `E_i + L_i`.
- `toSrc(t)`: scene `i` with `E_i <= t < E_i + L_i` (the last scene for `t >= D`), return `S_i + min(t - E_i, L_i)`.
- `isCut(t)`: render time `t` lies in a cut tail (`t - S_i > L_i`).

`now()` keeps returning render time. Seeking takes render time; a target in a cut tail clamps to that scene's new end (`S_i + L_i - 1 frame`).

## Data

Override path per scene: `"<sid>.@len": 3.0` (seconds). Absent means untrimmed. Setting it back to the original length removes it.

## Player UI

- **Timeline**: scene blocks, note pins, keyframe diamonds and the playhead are laid out in edited time over `D` (`pct(t)` becomes `toEd(t) / D`). Scrubbing maps the pointer's edited time back with `toSrc`. The beat grid stays in edited time (the music plays over the edited video).
- **Trim handle**: an 8px hot zone on the right edge of each scene block (`cursor: ew-resize`). Dragging sets `@len` live from the pointer's edited x: `L = clamp(x - E_i, 0.5, O_i)`, rounded to 1/fps; later blocks slide as it moves. Releasing marks the scene "Fix" (if it was "Review").
- Hidden for live projects whose bundle lacks `setScenes` (tooltip on the scene block: "Trimming needs an updated live renderer").
- **Scene panel**: under the scene name, when trimmed: `Length 4.0s → 3.0s` with Undo.
- **Times shown to the user** are edited time: the timecode (`fmt(toEd(now()))` / `fmt(D)`), scene lengths on blocks, note times, keyframe Time fields, element timing fields, script timestamps. Inputs that take a time convert with `toSrc` before storing.
- Notes and keyframes in a cut tail get a "cut" tag and are dimmed; they stay stored.

## Playback

- **mp4 projects**: in the playback loop, when `vid.currentTime` passes `S_i + L_i` for the current scene, jump to `S_(i+1)` (or pause at the end for the last scene). Music, if any, plays in edited time (`music.currentTime = toEd(now())`).
- **Live projects**: the composition itself is trimmed, so its frame clock is edited time. The `liveVideo` wrapper converts: `currentTime` getter returns `toSrc(frame / fps)`, setter seeks to `toEd(t) * fps`. The player calls `live.setScenes(lens)` whenever trims change.

## Live renderer contract

- New prop `scenes`: `{"S2": 3.0, ...}`, edited scene lengths in seconds (only trimmed scenes need be present).
- `window.MotionOSLive(el)` may return `setScenes(lens)`; it re-renders the Player with `inputProps.scenes` and the new `durationInFrames`.
- The composition lays scenes out back to back from those lengths (`from = round(E_i * fps)`, `durationInFrames = round(L_i * fps)`) and computes its total duration from them (Remotion `calculateMetadata`), so Export renders the trimmed length.
- `Ed` keyframe time uses the scene's **original** start (`round(S_i * fps)`), not its new `from`, since keyframes are stored in render time.
- Export: the player sends `{boxes, scenes}`; `serve.mjs` already passes the whole body through `$PROPS`.

## Prompt

A Trims section, placed after Edits and Notes:

```
## Trims (apply last)
- S2 Reveal: 4.0s -> 3.0s. Drop 14.0s-15.0s of the current render; everything after moves 1.0s earlier.
```

The prompt's header gains: "Times are in the current render (before trims)."

## SKILL.md

- Live projects: document the `scenes` prop, `setScenes`, `calculateMetadata`, and `Ed` using the original scene start.
- Apply feedback: for each trim, shorten the scene in code (its `Sequence` duration or equivalent) and in `reel.json` (`t[1]`), then shift every later scene's `t`, its elements' `t`, and `duration` by the cut amount; elements that ended after the cut get clamped to the new end. Apply trims after the other edits, whose times refer to the current render.

## Herdcats project

`src/index.ts` (calculateMetadata from `scenes`), `src/Main.tsx` (layout from `scenes`, provide original start to `SceneFromCtx`), `src/live.tsx` (`setScenes`, duration), rebuild `motionos-live.js`. Add `"scenes": {}` to `reel.json` `export.props`.

## Testing

- `selftest()` cases for `toEd`/`toSrc`/`isCut`: no trims (identity), before/inside/after one trimmed scene, a point in the cut tail, two trimmed scenes, the end of the video.
- Browser, mp4 project (qbot-tag): drag a scene's end left; later blocks, pins and diamonds move; total time drops; play across the trim and confirm it jumps; Undo restores.
- Browser, Herdcats: same drag; the live render plays the trimmed edit; keyframes on a later scene still hit their boxes; prompt shows the Trims line.
- Export on Herdcats; check the mp4's duration is shorter by the cut; frames just before and after the cut match the original at `S_i + L_i - ε` and `S_(i+1) + ε`.
- Regression: no trims behaves exactly as before (selftest from the keyframes work still passes on both projects).
