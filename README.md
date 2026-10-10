# Motion OS AXI

**Build a video with an agent. Review it scene by scene. Send edits, notes, and messages from the player.**

Motion OS AXI combines an agent skill, a local video editor, and a command-line feedback queue. Your agent creates the motion code and a `reel.json` describing the video. You review the result in your browser, adjust elements and pacing, and click **Send to Agent**. The agent picks up your feedback through `motion-os-axi poll`, applies it, and posts a reply in the Conversation pane.

![Motion OS AXI player showing the Script tab, a timestamped note on the video, the scene timeline, and the Conversation pane with queued changes and Send to Agent.](docs/screenshot-light.png)

Independently maintained by [Zhiyao](https://github.com/zhiyao), based on [Motion OS](https://github.com/jasonlee-breadcrumb/motion-os) by [Jason Lee](https://www.youtube.com/@JasonLeeFinance). The original MIT license and copyright notice are retained in [LICENSE](LICENSE).

## Install

The player and CLI need **Node.js 18 or newer**, with no package install or build step. Install **ffmpeg** for frame extraction and the CLI selftest. Creating and rendering videos requires the tools your agent chooses; Remotion is recommended.

For Claude Code:

```bash
git clone https://github.com/zhiyao/motion-os-axi ~/.claude/skills/motion-os-axi
```

For a single project, clone into `.claude/skills/motion-os-axi` instead. Other agents can follow [SKILL.md](SKILL.md) and invoke the CLI directly.

## Create and review a video

Ask your agent:

```text
Use motion-os-axi to make a 30 second launch video for my app.
My logo and screenshots are in ./brand.
Here's the reference I like: https://youtu.be/...
```

In Claude Code, you can also invoke the skill explicitly with `/motion-os-axi`. Its name is defined by the `name` field in [SKILL.md](SKILL.md).

The agent builds and checks the video, writes `reel.json`, opens the local player, and waits for feedback. The workspace has three parts:

- **Left — Scene, Script, Style, Media:** inspect scene elements, edit every word in order, adjust brand settings, and review assets.
- **Center — preview and timeline:** play the video, select and position elements, pin notes, add keyframes, and shorten scenes.
- **Right — Conversation:** type requests, review queued changes, send a batch, and read the agent's replies. Delivery badges track requests through pickup and completion; the listening indicator shows when an agent is polling.

### Editing controls

| Task | Control |
|---|---|
| Edit an element's fields | Switch to **Edit**, then click the element or select it in **Scene** |
| Change wording | Open **Script** and edit the text fields |
| Move or resize an element | In **Edit**, drag it or drag a corner |
| Animate position and size | Select an element and press **K** at the moments you want to keyframe |
| Shorten a scene | Drag its right edge left on the timeline, when trimming is available |
| Request a change at a specific spot | Press **N**, click the frame, and add a note |
| Add a general request | Type in **Conversation**; Enter queues it, Shift+Enter adds a new line |
| Submit feedback | Click **Send to Agent**; typed text is included with queued edits and notes |
| Undo a queued change | Click **Undo** beside it |
| Approve a scene | Set its status to **Approved** in the Scene tab |
| Render a new file | Click **Export MP4** in a project configured for export |
| Change appearance | Use the light/dark switch in the header |

Edits save automatically in your browser. Notes retain their timestamp, scene, frame position, and associated element. When a new version loads, sent edits are cleared while unsent work is retained.

### Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| E | Toggle Preview / Edit |
| N | Toggle note mode |
| K | Add a keyframe for the selected element |
| ← / → | Step one frame |
| Shift + ← / → | Step one second |
| [ / ] | Previous / next scene |
| Escape | Dismiss the note editor and return to Preview |

### Live previews and export

A project can provide a live renderer through `reel.json`. Supported position, size, and keyframe edits then appear in the rendered preview immediately. Live scene trimming requires the renderer's `setScenes` support. For ordinary MP4 projects, the agent applies the requested changes on the next render.

**Export MP4** appears when a project supplies an export configuration. It renders to a new file under `exports/` without overwriting earlier exports. Copy, color, and other field edits still go through the agent. See [SKILL.md](SKILL.md) for the live renderer and export contract.

## Agent feedback loop

Run the CLI with Node; no global installation is required:

```bash
# Open or reuse a project's local player
node bin/motion-os-axi.mjs open path/to/project

# Wait for the user to click Send to Agent
node bin/motion-os-axi.mjs poll path/to/project

# Validate the updated project after applying feedback and rendering
node bin/motion-os-axi.mjs check path/to/project

# Post a completion reply, then wait for the next batch
node bin/motion-os-axi.mjs poll path/to/project --reply "Updated the reveal and shortened the outro."
```

Feedback includes messages, field edits, position and size changes, keyframes, notes, scene trims, links, and scene statuses. Apply edits exactly, inspect note frames, and leave approved scenes untouched. Apply trims last because feedback timestamps refer to the current render. Re-render, update `reel.json`, and bump its version to the number requested by the feedback output. The player detects new versions automatically.

The Conversation pane delivers feedback directly to the local queue; no copy-and-paste step is needed. An agent must run `poll` to receive it. The queue and transcript persist in the project's `.motion-os-axi/` directory; add that directory to the project's `.gitignore`.

### CLI reference

| Command | Purpose |
|---|---|
| No arguments | List running players and waiting feedback |
| `open <project> [--no-open]` | Start or reuse a player |
| `check <project>` | Validate timing, IDs, boxes, files, and duration |
| `poll <project> [--timeout <seconds>] [--reply "text"]` | Receive feedback; optionally post an agent reply first |
| `frame <project> <seconds>` | Extract a render frame with ffmpeg |
| `export <project> [--wait]` | Check an export started in the player |
| `stop [<project>]` | Stop one player or all players |
| `setup-hook` | Print a Claude Code SessionStart hook for discovering running players |

Prefix commands with `node bin/motion-os-axi.mjs`. Use `--help` for command details and `--full` for expanded output. `poll` waits indefinitely by default; `--timeout` bounds the wait.

## Try the example

The repository includes a 44 second invoicing app launch video:

```bash
cd ~/.claude/skills/motion-os-axi
node bin/motion-os-axi.mjs open examples/qbot-tag
```

Its licensed music track has been removed; voice and sound effects remain.

You can also launch the server directly:

```bash
node player/serve.mjs path/to/project --port 5000 --no-open
```

## Project structure

```text
my-video/
  reel.json       video metadata, scenes, editable elements, and timings
  video.mp4       rendered video referenced by reel.json
  assets/         logos, screenshots, footage, and audio
  src/            motion source code
  .motion-os-axi/     local feedback queue, transcript, frames, and server log
  exports/        new video files produced by Export MP4
```

`reel.json` describes dimensions, frame rate, duration, brand settings, assets, scenes, and elements. Elements include editable properties, visibility times, source references, percentage-based boxes, and optional keyframes. Stable project, scene, and element IDs preserve edits across versions.

See the [example reel](examples/qbot-tag/reel.json) and [skill schema](SKILL.md) for details. Any renderer that produces a video file can work with the player.

## Storage and privacy

The player serves project files locally. Browser edits are stored per project in localStorage; sent feedback and conversation history are stored on disk in `.motion-os-axi/`. Motion OS AXI does not upload your video to a hosted service. Your agent provider's data handling applies to information the agent reads or receives.

## Development

```text
SKILL.md                 agent workflow and reel schema
bin/motion-os-axi.mjs     CLI entry point
bin/                     validation, queue storage, and feedback formatting
player/index.html        layout and styles
player/app.mjs           editor interactions and conversation UI
player/model.mjs         timeline, keyframes, indexes, and edit selectors
player/state.mjs         browser persistence and version migration
player/playback.mjs      live renderer video adapter
player/serve.mjs          local server entry point
player/server.mjs         request routing and feedback delivery
player/export.mjs         render job management
player/http.mjs           byte ranges and bounded request bodies
tests/                    regression and integration tests
examples/qbot-tag/        example video project
docs/                     screenshots and design notes
```

Run checks:

```bash
node --test tests/*.test.mjs
node bin/motion-os-axi.mjs --selftest
node player/serve.mjs --selftest
```

Integration tests need permission to listen on localhost. The CLI selftest also needs ffmpeg. For interaction checks, open a disposable project copy and run `await window.selftest()` in the browser console; it exercises editing and persistence.

MIT licensed. See [LICENSE](LICENSE).
