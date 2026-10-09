# Conversation pane: edit tabs on the left, a Lavish-style conversation with the agent on the right

Date: 2026-10-09 · Status: draft for review

## Goal

Reorganise the Motion OS player into three columns: edit tabs on the left, the video in the middle, and a Conversation pane on the right. Everything that is queued, sent, picked up or replied to lives in that pane, the way Lavish's Conversation panel works. The agent can reply into it, and the pane shows whether an agent is listening.

## Layout

- **Left panel** (340px): tabs Scene, Script, Style, Media. The Notes tab is removed.
- **Middle**: the stage, transport and timeline, unchanged. N still pins notes on the frame.
- **Right panel** (360px): Conversation. Header with the presence dot; scrolling transcript; queued items at the end; a composer pinned to the bottom with a text box and **Send to Agent**.
- The top bar loses **Send to Claude** and the "Waiting for Claude" badge (presence moves to the pane header). Export MP4 stays.
- **1100px and narrower**: the right panel becomes a drawer over the stage, opened from a "Conversation" button in the top bar that shows the queued count and presence colour.
- **Below 820px**: the drawer is a bottom sheet over the video (max 80% of the viewport height); the left panel stacks under the stage as today.

## Conversation content

Order: transcript (oldest first), then the queue, then the composer.

**Queue** (dashed bubbles, "Queued" label). Built from the current unsent state, so it always matches what Send will send:
- **Changes**: one bubble listing every unsent edit, one line each (`element · field: from → to`, from `editRow`). Each line has Undo, which deletes that override (same as the field's Undo). Clicking a line selects the element in the left panel.
- **Note**: one bubble per open note: pin number (the same number the pin shows), time, scene, element, editable text, × to delete. Clicking the header seeks to it.
- **Trim**: one bubble per trimmed scene (`S1: 11.0s → 9.0s`) with Undo.
- **Link**: one bubble per unsent link, with ×.
- **Message**: one bubble per queued composer message, with ×.

**Composer**: textarea; Enter queues the message, Shift+Enter is a newline. **Send to Agent** sends everything queued (disabled while nothing is queued or while a send is in flight). While sending, the queue bubbles read "Sending". On success they disappear from the queue and the batch appears in the transcript. On failure they stay queued and the composer shows the error.

**Transcript** bubbles:
- **You** (right-aligned): time sent, a one-line summary ("1 change, 6 notes, 1 trim"), expandable to the full list. Status chip: Sent → Picked up (when an agent leased it) → Done (when the agent replied after picking it up).
- **Agent** (left-aligned): time and the reply text, rendered as a Markdown subset: paragraphs, line breaks, `-`/`1.` lists, `**bold**`, `*italic*`, `` `code` ``, fenced code, and http(s) links. Everything else stays literal text. No raw HTML.

## Presence

The pane header shows one of:
- **Agent listening** (green): at least one `poll` is waiting on the server.
- **Agent working** (amber): a batch was picked up and no reply has arrived since.
- **No agent listening** (grey): neither. When items are queued or batches are waiting on the server, the hint reads "Your feedback waits here. Start an agent with `bin/monitor-motion-os` or ask Claude to poll."

## Server (`player/serve.mjs`)

- Transcript: `<project>/.motion-os/transcript.json`, an array of `{id, role: 'user'|'agent', at, batch?, text?, status?}` (status for user entries: `sent`, `picked`, `done`).
  - `POST /feedback` (existing) also appends a user entry `{id: batch.id, role: 'user', batch: payload, status: 'sent'}`.
  - When a poll leases a batch, its user entry becomes `picked`.
  - `POST /reply {text}` appends an agent entry and marks every `picked` user entry `done`.
- `GET /transcript` → `{entries, presence: 'listening'|'working'|'idle', waiting}`. The player calls it every 2 s (replacing the 3 s `/feedback` badge call) and re-renders the transcript when it changed.
- Presence: `listening` if any `/poll` request is held; else `working` if any user entry is `picked`; else `idle`.
- The `/reply`, `/transcript` endpoints use the same local-only check as `/feedback` and `/poll`.
- Request bodies over 1 MB are refused with 413.

## CLI (`bin/`)

- `poll <project> --reply "<text>"`: posts the reply first (to the server, or straight into the transcript file when no player is running), then polls as usual. `--reply` with no text is a usage error.
- The feedback payload gains `messages: [text, ...]` (composer messages); `formatFeedback` prints them as `messages[N]: ...` after `counts` (counts gains `messages=N`).
- `poll`'s help lines end with: "When done, reply with a short summary of what changed: `motion-os-axi poll <project> --reply \"...\"` (this also waits for the next Send)".
- `store.mjs` gains `readTranscript(dir)`, `appendTranscript(dir, entry)`, `markTranscript(dir, ids, status)`.

## Player state

- Queued composer messages live in browser state (`st.messages: [{id, text}]`), saved with the rest, so they survive a reload.
- `feedback()` includes `messages`; a successful send clears `st.messages`.
- `pendingEdits()`/the queue count includes messages.
- The Notes pane code (`notesPane`, its tab) is removed; note editing and deleting move to the note bubbles. `focusNote` opens the Conversation pane (and the drawer when narrow) and highlights the bubble.

## SKILL.md and Herdcats scripts

- Step 6: after applying feedback, finish with `motion-os-axi poll <project> --reply "<short summary>"`, which also starts waiting for the next Send.
- `bin/start-motion-os` and `bin/monitor-motion-os` in Herdcats: step 4 of the loop becomes "reply with a short summary using `poll --reply`, which also waits for the next Send".

## Testing

- `--selftest`: transcript append/mark; `formatFeedback` with messages; a live server: POST feedback → transcript has a `sent` user entry; held poll → presence `listening`; lease → entry `picked`, presence `working` (after the poll returns); POST /reply → agent entry, user entry `done`, presence `idle`; `/transcript` refuses a foreign Host; body over 1 MB → 413.
- Player `selftest()`: queue bubbles reflect state (one Changes bubble with N lines, one bubble per note/trim/message); Undo on a Changes line removes that override; a message queued then sent is cleared; Markdown renderer escapes HTML and renders the subset.
- Browser E2E on qbot-tag: queue an edit, a note, a message; Send to Agent; `poll` returns all three including `messages`; `poll --reply "Done: …"` shows an agent bubble and the status chip reads Done; presence goes listening → working → idle/listening.
- Screenshots at 1400px, 1000px (drawer) and 390px (bottom sheet); no horizontal page scroll; composer stays visible.
- Regression: keyframes, trims and the earlier selftests still pass on both projects.
