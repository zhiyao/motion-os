---
name: motion-os-axi
description: Build motion graphics and launch videos in code, then open them in Motion OS AXI, a local scene-by-scene review player where the user edits copy, pins notes on the frame, and sends feedback back. Use when the user asks for a motion graphic, launch video, explainer, product video or animated ad, says "motion-os-axi", or wants feedback from an open Motion OS AXI player.
---

# Motion OS AXI

Motion OS AXI is a workflow plus a local player. You build the video in code, render it, describe it in `reel.json`, and open the player. The user reviews it scene by scene, edits copy, pins notes on the frame, clicks **Send to Agent**, and you pick it up with `motion-os-axi poll`. You apply it, re-render, bump the version, and the player reloads itself.

`SKILL_DIR` below means the folder this file is in (the player is at `SKILL_DIR/player/`).

Drive it with the `motion-os-axi` CLI (an [AXI](https://axi.md)): `node "$SKILL_DIR/bin/motion-os-axi.mjs"`. Run it with no arguments for running players; every command ends with next steps, and `--help` works everywhere. It needs only Node 18+ (ffmpeg for `frame`). Below, `motion-os-axi` means that command.

## 1. Set up the project

```
<project>/
  reel.json     what the player reads: scenes, elements, copy, timings, assets
  video.mp4     the latest render ("src" in reel.json)
  assets/       images, footage, logos, music the user gives you
  src/          your motion code
```

Only ask for what's missing: what the video is for, length, aspect ratio, brand (colors, fonts, logo), assets, and a reference video if they have one. Defaults: 1920x1080, 30 fps, 20 to 45 seconds. If the user has no assets, recreate the reference's look so they can swap things in later.

## 2. Build it

- Recommended: [Remotion](https://www.remotion.dev) (React). Keep every on-screen text, image path, color and timing in `reel.json` and import it in the composition, so most feedback is "edit reel.json, re-render".
- Any tool works if it outputs a video file (Hyperframes, HTML canvas, After Effects export).
- Never run `npm install` inside a cloud-synced folder (Google Drive, iCloud, Dropbox). Build in a temp folder and copy the source back.
- Remotion is free for individuals and companies of 3 or fewer people; larger companies need a license.

## 3. Render and check it yourself

```bash
npx remotion render src/index.ts Main video.mp4 --codec=h264 --crf=18
ffmpeg -v error -y -i video.mp4 -vf "fps=1,scale=320:-1,tile=6x6" -frames:v 1 sheet.jpg
```

Read the contact sheet before showing anything. Check text is readable, nothing overlaps faces or important UI, and audio levels are sane. Fix obvious problems first. Then run `motion-os-axi check <project>` and fix any errors before showing it.

## 4. Write reel.json

See `examples/qbot-tag/reel.json` for a full example.

```jsonc
{
  "id": "acme-launch",            // stable, used to store the user's edits
  "title": "Acme launch",
  "version": 1,                   // bump on every render; the player reloads when it changes
  "path": "/abs/path/to/project", // shown in poll output so you know where to work
  "src": "video.mp4",
  "w": 1920, "h": 1080, "fps": 30, "duration": 32.0,
  "reference": "Linear launch video",
  "brand": {
    "colors": [{"id": "accent", "name": "Accent", "v": "#5B5BF7"}],
    "fonts": [{"id": "head", "name": "Headlines", "v": "Inter Tight"}],
    "logo": "assets/logo.svg"
  },
  "audio": {"music": null, "bpm": 120, "drop": 4.0, "musicVol": 0.6, "sfxVol": 0.8},
  "assets": [{"id": "assets/logo.svg", "name": "logo.svg", "type": "image", "from": "User"}],
  "scenes": [
    {"id": "S1", "name": "Hook", "t": [0, 4.5], "els": [
      {"id": "headline", "label": "Headline", "t": [0.3, 4.3], "box": [20, 38, 60, 24], "src": "src/Hook.tsx:12",
       "props": {
         "text":   {"type": "text",   "label": "Text", "v": "Meet Acme"},
         "color":  {"type": "color",  "label": "Color", "v": "brand.accent"},
         "motion": {"type": "motion", "label": "Motion", "v": "Words blur in one by one"}
       }}
    ]}
  ],
  "notes": []
}
```

Rules:
- One scene per story beat. Scene `t` values come from the actual render and cover 0 to `duration` with no gaps.
- An element is anything a viewer might want to change. `t` is when it's visible. `box` is `[x, y, w, h]` in percent of the frame (use `null` for voiceover or audio). `src` is the file or `file:line` that draws it.
- An element whose position/size animates gets `keys`: `[{"t": 5.4, "box": [x, y, w, h]}, {"t": 7.8, "box": [...]}]` (render-time seconds, 1 or 2, ease in-out between, held before and after). `box` stays its resting box. The player shows and edits these as keyframes.
- Control types: `text`, `longtext`, `number`, `color` (a value like `brand.accent` links it to the palette), `media` (an asset id), `list` (with `cols`), `choice` (with `options`), and `motion` (free text, only you can change it).
- Keep scene and element ids stable between versions. The player matches the user's edits by id.

### Live projects (instant edits + Export MP4)

For Remotion projects, give the player a live renderer so Edit mode changes show for real and the user can export without you:
- Wrap each element with a `box` in a small `Ed` component. The `boxes` prop maps element id to one of:
  - `[x, y, w, h, nx, ny, nw, nh]`: a move (reel.json box, then the edited box, % of frame).
  - `{"box": [x, y, w, h], "keys": [{"t": 12.0, "box": [nx, ny, nw, nh]}, ...]}`: keyframes, `t` in absolute video seconds. Hold the first box before the first key and the last after the last; ease in-out (`p < .5 ? 4p³ : 1 - (-2p + 2)³ / 2`) between.
  - no entry: the element's `keys` from reel.json, if any (bundled from reel.json, so rebuild the bundle when they change). An entry replaces them (`keys: []` = no animation). Don't also animate that element's box in scene code, or the motion is applied twice.

  Work out `[nx, ny, nw, nh]` for the current frame, then apply `translate(nx-x %, ny-y %) scale(nw/w)` with `transform-origin: x% y%`. `useCurrentFrame()` is relative to the scene's `<Sequence>`, so give `Ed` the scene's start frame (a context set where the Sequence is mounted) and use `t = (sceneFrom + frame) / fps`. No edit means render children untouched.
- Lay scenes out from a `scenes` prop (`{"S2": 3.0}`: edited lengths in seconds, only trimmed scenes): each scene's `Sequence` starts where the previous edited one ends and lasts its edited length (never longer than the original). Compute the composition's `durationInFrames` from those lengths with `calculateMetadata`, and add `setScenes(lens)` to `MotionOSAXILive` (re-render the Player with the new `scenes` and duration). Keyframe times stay in the untrimmed clock, so `Ed`'s scene start is the scene's original `t[0]`, not its new start. Put `"scenes": {}` next to `"boxes": {}` in `export.props`. Without `setScenes` the player offers no trimming.
- Add an entry that mounts `@remotion/player` and sets `window.MotionOSAXILive = el => ({ref, setBoxes, setRate})`. Bundle it with esbuild into the project folder and set `"live": "motion-os-axi-live.js"` in reel.json.
- Add `"export": {"cwd": "<folder with node_modules>", "props": {...}, "cmd": "..."}`. The command gets `$PROPS` (JSON with the edits), `$RAW`, `$OUT` (`exports/<id>-<time>.mp4`, never overwritten) and `$PROJECT`. Example: `npx remotion render src/index.tsx Main "$OUT" --props="$PROPS"`.
- `staticFile()` paths are served from the project's `public/` folder.
- Elements with a `box` must be wrapped, or set `box` to null, otherwise dragging them does nothing.

## 5. Open the player

Run (the player keeps running in the background while you work):

```bash
node "$SKILL_DIR/bin/motion-os-axi.mjs" open "<project>"
```

It starts the player (or reuses the one already serving this project), opens the browser and prints the URL. Motion OS AXI keeps its feedback queue, frames and log in `<project>/.motion-os-axi/`; add that to the project's `.gitignore`.

Then tell the user, in two or three lines: Preview plays it; Edit (E) pauses so they can click anything, drag to move, drag a corner to resize, press K at two moments to animate an element between them, drag a scene's end on the timeline to shorten it, press N to pin a note (notes appear in the Conversation pane on the right, where they can also type messages), the Script tab has every word, and when they're done, click **Send to Agent** at the bottom of the Conversation pane.

## 6. Apply feedback

Run `motion-os-axi poll <project>` and leave it running until it returns (in the foreground, or as a background job your harness tracks and wakes you for; if it's interrupted, run it again, feedback stays queued). It prints the user's messages, edits, notes, trims, links and scene statuses as rows; times are render time in seconds. Then:
- **Edits** (before -> after): apply exactly, in `reel.json` and the code.
- **Size and position** edits come as `[x, y, w, h]` in % of the frame plus a scale. Move and scale that element in the code to match, then update its `box` in `reel.json`.
- **Keyframes** come as an edit row with field `keyframes`: `from` is the current keys, `to` like `12s [x y w h] -> 14s [x y w h] (ease in-out)` or `none (remove the animation)`. Live projects: set (or remove) the element's `keys` in reel.json; `Ed` animates them, no motion code. `Ed` reads reel.json at build time, so rebuild the live bundle (and re-render) after changing `keys`, or the player previews the old motion. mp4 projects: implement the motion in code (ease in-out, held before and after, on top of its existing motion) and record the same `keys` in reel.json. Keep `box` as the resting box. Once the new version loads, the player drops the sent keyframe edit and shows the reel.json `keys`.
- **Trims** come as `trims` rows (`scene,name,from,to,drop,shift`, e.g. `S2,Reveal,4,3,14.00-15.00s,-1.00s`). Apply them last: all other times in `poll` output are in the current render. Then cut the scene in code (its `Sequence` duration or equivalent; don't speed it up), set its `t[1]` in `reel.json`, shift every later scene's `t`, their elements' `t` and keyframe/note times by the cut, clamp elements that ran past the new end, and update `duration`.
- **Notes**: each has a timestamp, scene, x/y position, and the element and source file it sits on. Grab that frame (`motion-os-axi frame <project> <t>`) and look at it before deciding what the note means.
- **Links**: download them into `assets/`. Ask first if it isn't clearly the user's own file.
- Leave scenes marked "approved" untouched.
- Re-render, check the contact sheet, update `reel.json` (timings, copy) and set `version` to the number `poll` asks for, and run `motion-os-axi check <project>`. The player notices within about 3 seconds and reloads.
- Finish with `motion-os-axi poll <project> --reply "<short summary of what changed and anything you couldn't do>"`. The reply shows in the user's Conversation pane, and the same command waits for their next Send.
