# motion-os-axi: an agent-facing CLI for Motion OS

Date: 2026-10-09 · Status: draft for review

## Goal

Make Motion OS an AXI (https://axi.md, "10 principles for agent-ergonomic CLI design"). The agent drives it through one CLI with compact output, and the user's feedback reaches the agent through `poll` instead of copy-paste. The player UI stays the review surface for the human.

## Decisions (agreed)

- Ships inside the skill as `bin/motion-os-axi.mjs`, run with `node "$SKILL_DIR/bin/motion-os-axi.mjs"`. Zero dependencies (Node 18+ built-ins; ffmpeg/ffprobe optional). Not published to npm.
- Send in the player delivers to `poll` only. The copy-paste prompt sheet is removed.
- `serve.mjs` keeps its HTTP logic and becomes the process the CLI starts.

## Output conventions (all commands)

- **TOON** on stdout, hand-encoded (`bin/toon.mjs`):
  - scalar: `key: value`
  - list of scalars: `key[N]: a,b,c`
  - list of objects: `key[N]{f1,f2,...}:` then one indented row per item, values comma-separated
  - a string value is quoted (JSON string escapes) when it contains `,` `:` `"` a newline, leading/trailing space, or is empty; numbers and booleans print bare; `null` prints `null`
- **Truncation**: text fields (note text, copy, file lines) cap at 120 chars with a `…(+N chars)` suffix; `--full` disables it.
- **Empty states** are explicit, e.g. `players: none running`, `problems: 0`.
- **Aggregates** first: counts and totals before rows.
- **`help[N]:`** closes every output with next-step command templates (`<project>`, `<t>` placeholders; fixed flags spelled out).
- **Errors**: `error: <code>` and `message: <text>` on stdout, exit 1; unknown flag or command exits 2 with `error: usage`. Debug and server logs go to stderr or the log file, never stdout. Nothing prompts.
- **`--help`** on the root and every command: a short usage block, in the same TOON shape.
- `<project>` is a folder containing `reel.json`; default `.`. Paths in output are absolute.

## Commands

### (no arguments)
Content first: one line describing the tool and the bin path, then running players.
```
bin: /…/motion-os/bin/motion-os-axi.mjs
description: Motion OS: build a video in code, review it in a local player, get the user's feedback back with poll
players[1]{project,url,version,scenes,waiting}:
  /…/herdcats-launch-video,http://localhost:4321,2,7,1
help[2]: …
```
`waiting` is the number of undelivered Send batches. With none: `players: none running`.

### open <project> [--no-open]
- Runs `check` silently first; with errors, still opens but prints `problems: N (run check)`.
- If the registry has a live server for this project, reuse it. Otherwise spawn `node serve.mjs <project> --no-open` detached, logging to `<project>/.motion-os/server.log`; wait (≤5 s) for it to report its port.
- Opens the browser unless `--no-open`. Prints `project`, `url`, `version`, `status: started|reused`.

### check <project>
Validates reel.json. Prints `problems: N` then `problems[N]{level,where,message}` rows. Exit 1 when any `error`.
- error: reel.json missing or not JSON; missing `id`, `version`, `src`, `fps`, `duration`, `scenes`
- error: first scene doesn't start at 0, gaps or overlaps between consecutive scenes, last scene doesn't end at `duration` (tolerance 1 frame)
- error: duplicate scene or element ids
- error: element `box` not 4 numbers within 0–100 (x+w and y+h ≤ 100.5)
- error: element `t` outside its scene
- error: `src` or a `media`/asset path that doesn't exist in the project (or `public/`)
- warn: `duration` differs from the mp4's (ffprobe) by more than 0.1 s; skipped silently without ffprobe
- warn: `live` set but the bundle file missing; `export` set without `cmd`

### poll <project> [--timeout <s>]
Waits for the next Send batch and prints it, then removes it from the queue (delivery consumes it). Default timeout 0 = wait forever; on timeout prints `feedback: none yet` and exits 0. If no player is running it reads the queue file directly; when that is empty too: `error: no_player` with a help line to `open`.

Output (render time throughout; times `mm:ss.s`):
```
feedback: <title> v<version> → set version <version+1>
counts: edits=E notes=N trims=T links=L
edits[E]{at,scene,element,field,from,to,src}:
notes[N]{n,at,scene,x,y,on,src,text}:
trims[T]{scene,name,from,to,drop,shift}:
links[L]: url,…
scenes[S]{id,name,status}:
help[…]: apply edits exactly then notes; leave approved scenes alone; grab a note's frame with `frame <project> <t>`; apply trims last; re-render, run check, set version
```
`field` covers text/props, `timing`, `size+position` (from/to as `[x y w h]`), `keyframes` (to as `12s [x y w h] -> 14s [x y w h]`, ease in-out), `motion`, style colors/fonts/logo, audio. Several batches waiting: they are merged in order into one response.

### frame <project> <t>
Saves the render's frame at `t` seconds (render time) to `<project>/.motion-os/frames/<t>.jpg` with ffmpeg and prints `frame: <path>`. Without ffmpeg: `error: no_ffmpeg`.

### export <project> [--wait]
Reports the Export MP4 job the user started from the player: `state`, `pct`, `out`, last log line. `--wait` blocks until done or error. No running player: `error: no_player`. (Starting an export from the CLI is out of scope: the edits to bake in live in the browser.)

### stop [<project>]
Stops that project's player, or all registered players. Prints `stopped[N]: …` or `players: none running`.

### setup-hook
Prints a Claude Code `SessionStart` hook snippet (JSON) that runs `node <bin>` with no arguments, plus where to paste it (`~/.claude/settings.json` → `hooks`). Does not edit any file.

### --selftest
Runs the built-in checks (TOON encoding, reel checks, queue, range parsing) and prints `selftest ok`.

## Server and registry

- Registry: `~/.motion-os/players.json`, `{ "<abs project>": {port, pid, started} }`. `serve.mjs` adds its entry on listening and removes it on exit (SIGINT/SIGTERM). Readers drop entries whose pid is dead.
- Queue: `<project>/.motion-os/inbox.json`, an array of batches `{id, at, version, payload}`. Survives server restarts.
- New endpoints on `serve.mjs` (same Origin rule as `/export`: only `localhost`/`127.0.0.1` origins may POST):
  - `POST /feedback` → appends the batch, returns `{ok, id, waiting}`.
  - `GET /feedback` → `{waiting}` count (the player shows "Waiting for Claude" while > 0).
  - `GET /poll` → long-poll: answers as soon as the queue is non-empty with all batches and clears them; otherwise holds the request (the CLI reconnects every 25 s).
- `serve.mjs` stays runnable on its own (`node serve.mjs <project>`), as today.

## Player changes

- `feedback()` builds the structured payload (the data `prompt()` formats today: edits with their where/field/from/to/src, notes, trims, links, scene statuses, title, version, path).
- **Send** posts it to `/feedback`. On success: mark edits/notes/links as sent (as Copy did), toast "Sent to Claude". On failure: toast the error, nothing marked sent.
- The prompt sheet and `prompt()` are removed. The top-bar badge shows "Waiting for Claude" while the server reports undelivered batches.
- `selftest()` keeps its checks, with the prompt-text assertions rewritten against `feedback()`.

## SKILL.md

- New "AXI" note at the top: run `node "$SKILL_DIR/bin/motion-os-axi.mjs"` for status; every command prints next steps.
- Step 3 gains `check`. Step 5 becomes `open`. Step 6 becomes: run `poll` (foreground, or a harness-tracked background job; re-run it if interrupted, feedback stays queued), apply, re-render, `check`, set version.
- Mention `.motion-os/` (queue, frames, log) and suggest adding it to the project's `.gitignore`.

## Testing

- `node bin/motion-os-axi.mjs --selftest`: TOON (quoting, nesting, empty lists), each check rule against small fixture reels, queue append/drain, `serve.mjs --selftest` still passes.
- CLI on the qbot-tag example: no-arg with nothing running; `open --no-open` (started), again (reused), no-arg lists it; `check` → problems 0; `check` on a broken copy → each rule fires, exit 1; `frame`; `stop`.
- End to end: `open` qbot-tag, start `poll` in the background, in the browser edit a text, add a note and a trim, press Send; `poll` returns all three with correct render times; a second `poll --timeout 2` prints `feedback: none yet`. Player shows "Sent to Claude" and the badge clears.
- Herdcats: Send with keyframes; poll row shows `keyframes`; `export --wait` after starting Export in the browser reports `done` and the path.
- Player `selftest()` passes on both projects.
