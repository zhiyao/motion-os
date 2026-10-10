# Conversation Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three-column player (edit tabs left, video middle, Conversation right) where everything queued, sent, picked up and replied lives in a Lavish-style conversation with a composer and **Send to Agent**, plus `poll --reply` so the agent can answer and a presence indicator.

**Architecture:** The server keeps a per-project transcript (`.motion-os-axi/transcript.json`) next to the queue: Send appends a user entry, a lease marks it picked, `/reply` appends an agent entry and marks picked entries done; `/transcript` returns entries plus presence. The CLI's `poll --reply` posts first, then polls. The player splits the conversation log into a transcript container (refreshed every 2 s from `/transcript`) and a queue container (rendered from local state), so typing in a queued note never gets clobbered by a refresh.

**Tech Stack:** Node 18 built-ins; single-file player (HTML/CSS/JS); `chrome-devtools-axi` for browser checks.

**Spec:** `docs/specs/2026-10-09-conversation-pane-design.md`

## Global Constraints

- Left panel 340px with tabs Scene, Script, Style, Media (Notes tab removed); right Conversation panel 360px; middle unchanged.
- ≤1100px: Conversation is a right-side drawer opened from a top-bar "Conversation" button showing the queued count; <820px: bottom sheet, max 80% of viewport height.
- Top bar loses Send to Claude and the waiting badge; Export MP4 stays.
- Presence labels exactly: "Agent listening" (green), "Agent working" (amber), "No agent listening" (grey); idle hint: "Your feedback waits here. Start an agent with `bin/monitor-motion-os-axi` or ask Claude to poll."
- User transcript statuses: sent → picked ("Picked up") → done ("Done").
- Agent replies render only: paragraphs, line breaks, `-`/`1.` lists, `**bold**`, `*italic*`, `` `code` ``, fenced code, http(s) links. No raw HTML.
- `/reply` and `/transcript` use the same local-only check as `/feedback`/`/poll`; request bodies over 1 MB → 413.
- Composer: Enter queues, Shift+Enter newline; Send to Agent disabled when nothing is queued or a send is in flight.
- Zero dependencies. Commits only after asking the user.

## Review Focus

1. Typing in a queued note while the 2 s transcript refresh runs must keep focus and text. (Task 4 Step 1: refresh with focus in a note textarea.)
2. An agent reply containing HTML or a script tag shows as text. (Task 4 Step 1 markdown test.)
3. `poll --reply` with no player running must still record the reply. (Task 1 Step 1 CLI test.)
4. Double-clicking Send to Agent sends one batch. (Task 4 Step 1 concurrent-send test.)
5. At drawer and phone widths the composer stays on screen and the page has no horizontal scroll. (Task 3 Step 5.)

---

## File Structure

- `bin/store.mjs`: + `newId()`, `transcriptPath`, `readTranscript`, `appendTranscript`, `markTranscript`.
- `bin/format.mjs`: + `messages`.
- `bin/motion-os-axi.mjs`: `poll --reply`, valued-flag parsing, help text.
- `bin/selftest.mjs`: new cases.
- `player/serve.mjs`: body limit helper, transcript writes, `/reply`, `/transcript`, presence.
- `player/index.html`: layout, Conversation pane, queue, composer, transcript rendering, markdown, presence, removal of Notes tab and top Send.
- `SKILL.md`; Herdcats `bin/start-motion-os-axi`, `bin/monitor-motion-os-axi`.

Helpers for browser steps:

```bash
cd /Users/zhiyaochan/Projects/skills/motion-os
export CHROME_DEVTOOLS_AXI_SESSION=motionos MOTION_OS_AXI_HOME=$(mktemp -d)
E() { chrome-devtools-axi eval "$1" 2>&1 | head -1; }
T() { E "(async () => { try { return await selftest(); } catch (e) { return 'FAIL ' + e.message; } })()"; }
S=/private/tmp/claude-501/-Users-zhiyaochan-Projects-ios-app-herdcats/ea6b1804-48f6-461b-b532-1b5534a92163/scratchpad
```

Use qbot-tag for browser work: `node bin/motion-os-axi.mjs open examples/qbot-tag --no-open` (temp registry), then `URL=$(node bin/motion-os-axi.mjs | grep -o 'http://localhost:[0-9]*' | head -1)`. Do NOT poll the Herdcats project: another Claude session owns it.

---

### Task 1: Transcript store, messages in poll output, `poll --reply`

**Files:** Modify `bin/store.mjs`, `bin/format.mjs`, `bin/motion-os-axi.mjs`, `bin/selftest.mjs`.

**Interfaces:**
- Produces: `newId(): string`; `transcriptPath(dir)`; `readTranscript(dir): Entry[]`; `appendTranscript(dir, entry): Entry` (adds `id` if missing and `at`); `markTranscript(dir, pred: (e) => boolean, status): number` (only `role === 'user'` entries; returns count changed). `Entry = {id, at, role: 'user'|'agent', batch?, text?, status?}`. `formatFeedback` output gains `messages[N]` and `counts` gains `messages=N`.

- [ ] **Step 1: Failing tests.** In `bin/selftest.mjs`, extend the store import with `appendTranscript, readTranscript, markTranscript` and add `import {execFileSync} from 'node:child_process';` (keep `spawn`). Add after the queue checks (`ack removes them`):

```js
  // transcript
  const u = appendTranscript(proj, {role: 'user', batch: {notes: [1]}, status: 'sent'});
  appendTranscript(proj, {role: 'agent', text: 'hi'});
  eq(readTranscript(proj).map(e => [e.role, e.status ?? e.text]), [['user', 'sent'], ['agent', 'hi']], 'transcript append');
  eq(markTranscript(proj, e => e.id === u.id, 'picked'), 1, 'mark one user entry');
  eq(markTranscript(proj, () => true, 'done'), 1, 'agent entries are never marked');
  eq(readTranscript(proj)[0].status, 'done', 'status stored');
  // poll --reply with no player running records the reply in the transcript file
  const cli = fileURLToPath(new URL('./motion-os-axi.mjs', import.meta.url));
  try { execFileSync(process.execPath, [cli, 'poll', proj, '--reply', 'Done: all good', '--timeout', '1'], {env: process.env, stdio: 'pipe'}); } catch {}
  eq(readTranscript(proj).at(-1).text, 'Done: all good', 'reply recorded without a player');
  let usageExit = 0; try { execFileSync(process.execPath, [cli, 'poll', proj, '--reply'], {env: process.env, stdio: 'pipe'}); } catch (e) { usageExit = e.status; }
  eq(usageExit, 2, '--reply needs text');
  fs.rmSync(path.join(proj, '.motion-os-axi', 'transcript.json'), {force: true});   // the server checks below start from an empty transcript
```

and in the format section add:

```js
  const fm = formatFeedback([fb(2, {messages: ['make it faster', 'x'.repeat(130)]})], {full: false});
  eq([fm.counts, fm.messages[0], fm.messages[1].endsWith('…(+10 chars)')], ['edits=0 notes=0 trims=0 links=0 messages=2', 'make it faster', true], 'messages in poll output');
```

and change the existing counts assertion to `'edits=1 notes=1 trims=0 links=1 messages=0'`.

- [ ] **Step 2: Run, expect fail.** `node bin/motion-os-axi.mjs --selftest` → `does not provide an export named 'appendTranscript'`.

- [ ] **Step 3: Implement.** `bin/store.mjs`: add `export const newId = () => Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');`, use it in `pushBatch` (`id: newId()`), and append:

```js
// Transcript: what the user sent and what the agent replied, shown in the player's Conversation pane.
export const transcriptPath = dir => path.join(dir, '.motion-os-axi', 'transcript.json');
export const readTranscript = dir => readJson(transcriptPath(dir), []);
export function appendTranscript(dir, entry){ const e = {id: newId(), at: new Date().toISOString(), ...entry}; writeJson(transcriptPath(dir), [...readTranscript(dir), e]); return e; }
export function markTranscript(dir, pred, status){
  let n = 0; const t = readTranscript(dir).map(e => e.role === 'user' && pred(e) && e.status !== status ? (n++, {...e, status}) : e);
  if (n) writeJson(transcriptPath(dir), t); return n;
}
```

(`markTranscript` skips entries already in that status, so marking `done` twice counts 0.)

`bin/format.mjs`: after `links` add `const messages = all('messages').map(m => trunc(m, full));`, append ` messages=${messages.length}` to `counts`, and insert `if (messages.length) o.messages = messages;` right after `counts` is set (before edits).

`bin/motion-os-axi.mjs`:
- replace the `pos` line with:

```js
const VALUED = new Set(['--timeout', '--reply']);
const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
```

- import `appendTranscript, markTranscript` from `./store.mjs`.
- `poll` command: `usage: 'poll <project> [--timeout <s>] [--reply "<text>"]'`, `about: 'Optionally post a reply to the Conversation pane, then wait for the user to press Send'`, `flags: ['--timeout', '--reply']`.
- at the top of `cmdPoll`, after `dir`/`limit`:

```js
  if (flags.has('--reply')) {
    const text = optVal('--reply');
    if (!text || text.startsWith('--')) usage('--reply needs the text of your reply');
    const p = player(dir);
    if (p) { const r = await fetch(p.url + '/reply', {method: 'POST', body: JSON.stringify({text})}).catch(() => null); if (!r?.ok) fail('reply_failed', 'the player did not accept the reply'); }
    else { appendTranscript(dir, {role: 'agent', text}); markTranscript(dir, e => e.status === 'picked', 'done'); }
  }
```

- in `show`'s help list, replace the last line with: `` `Apply trims last; re-render, run \`${AXI} check ${dir}\`, set reel.json "version" as shown in feedback` `` and add a fifth line: `` `When done, reply with a short summary of what changed: \`${AXI} poll ${dir} --reply "..."\` (this also waits for the next Send)` ``.

- [ ] **Step 4: Run, expect pass.** `node bin/motion-os-axi.mjs --selftest` → `selftest ok`.

- [ ] **Step 5: Checkpoint.**

---

### Task 2: Server transcript, `/reply`, `/transcript`, presence, body limit

**Files:** Modify `player/serve.mjs`, `bin/selftest.mjs`.

**Interfaces:**
- Consumes: Task 1 store functions.
- Produces: `POST /reply {text}` → `{ok: true}` (400 on empty text); `GET /transcript` → `{entries, presence: 'listening'|'working'|'idle', waiting}`; `POST /feedback` also appends a user entry with the batch's id.

- [ ] **Step 1: Failing tests.** In `bin/selftest.mjs`'s server block, change the `raw` helper to take a path: `const raw = (headers, p = '/poll?ms=100') => new Promise(r => http.get({host: '127.0.0.1', port: Number(new URL(base).port), path: p, headers}, res => { res.resume(); r(res.statusCode); }));` (existing calls keep working). Before the existing `const first = await Promise.race([p1, p2]);`, record which poll won: replace that line with:

```js
    const first = await Promise.race([p1.then(j => (j.who = 1, j)), p2.then(j => (j.who = 2, j))]);
    const other = first.who === 1 ? p2 : p1;
```

Then, after the cross-site checks, add:

```js
    // transcript and presence
    const tr = async () => (await fetch(base + '/transcript')).json();
    let T = await tr();
    eq(T.entries.map(e => [e.role, e.status]), [['user', 'picked']], 'sent batch is in the transcript, picked');
    eq(T.presence, 'listening', 'a held poll means listening');
    await fetch(base + '/reply', {method: 'POST', body: JSON.stringify({text: 'Done: changed the title'})});
    T = await tr();
    eq(T.entries.map(e => [e.role, e.status ?? e.text]), [['user', 'done'], ['agent', 'Done: changed the title']], 'reply lands and closes the batch');
    eq((await fetch(base + '/reply', {method: 'POST', body: '{"text":""}'})).status, 400, 'empty reply refused');
    await fetch(base + '/feedback', {method: 'POST', headers: {origin: base}, body: JSON.stringify({hello: 2})});
    const got = await other;   // the still-waiting poll takes it
    eq([got.batches[0].payload.hello, (await tr()).presence], [2, 'working'], 'picked with nobody polling means working');
    await fetch(base + '/ack', {method: 'POST', body: JSON.stringify({ids: got.batches.map(b => b.id)})});
    eq((await fetch(base + '/feedback', {method: 'POST', headers: {origin: base}, body: 'x'.repeat(1100000)})).status, 413, 'oversized body refused');
    eq(await raw({host: 'evil.example'}, '/transcript'), 403, 'transcript is local-only');
```

- [ ] **Step 2: Run, expect fail.** `--selftest` → `FAIL ... sent batch is in the transcript, picked` (`/transcript` 404 → JSON parse error is also an acceptable failure).

- [ ] **Step 3: Implement** in `player/serve.mjs`:
- import `appendTranscript, readTranscript, markTranscript` too.
- add above the server:

```js
// Reads a request body, refusing anything over 1 MB.
function readBody(req, res, done){
  let body = '', size = 0, big = false;
  req.on('data', c => { size += c.length; if (size > 1e6) big = true; else body += c; });
  req.on('end', () => big ? res.writeHead(413).end() : done(body));
}
const presence = () => waiters.some(r => !r.writableEnded && !r.destroyed) ? 'listening' : readTranscript(dir).some(e => e.status === 'picked') ? 'working' : 'idle';
```

- in `deliver()`, after `if (!batches.length) return;` add `markTranscript(dir, e => batches.some(b => b.id === e.id), 'picked');`.
- extend the local-only list to `['/feedback', '/poll', '/ack', '/export', '/reply', '/transcript']`.
- replace the `/ack` and `/feedback` POST body reading with `readBody`:

```js
  if (url === '/ack') return readBody(req, res, body => { try { ackQueue(dir, JSON.parse(body || '{}').ids || []); res.writeHead(200, {'Content-Type': 'application/json'}).end('{"ok":true}'); } catch { res.writeHead(400).end(); } });
  if (url === '/reply') return readBody(req, res, body => {
    let text = ''; try { text = String(JSON.parse(body || '{}').text || '').trim(); } catch {}
    if (!text) return res.writeHead(400).end();
    appendTranscript(dir, {role: 'agent', text}); markTranscript(dir, e => e.status === 'picked', 'done');
    res.writeHead(200, {'Content-Type': 'application/json'}).end('{"ok":true}');
  });
  if (url === '/transcript') return res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({entries: readTranscript(dir), presence: presence(), waiting: readQueue(dir).length}));
```

and in `/feedback` POST: `return readBody(req, res, body => { try { const payload = JSON.parse(body || '{}'), b = pushBatch(dir, payload); appendTranscript(dir, {id: b.id, role: 'user', batch: payload, status: 'sent'}); send(200, {ok: true, id: b.id, waiting: readQueue(dir).length}); deliver(); } catch (e) { send(400, {ok: false, error: e.message}); } });`

(`deliver()` must run after `appendTranscript`, so a waiting poll's `markTranscript` finds the entry.)

- [ ] **Step 4: Run, expect pass.** `node bin/motion-os-axi.mjs --selftest` and `node player/serve.mjs --selftest` → `selftest ok` both.

- [ ] **Step 5: Checkpoint.**

---

### Task 3: Three-column layout, drawer and bottom sheet

**Files:** Modify `player/index.html` (CSS `.desk` line ~71, `.panel` ~147, media queries ~266-279; header ~282-296; desk markup ~298-323; `TABS` ~663, `renderTabs`, `renderPane`, `notesPane` ~776-781; `focusNote` ~892).

**Interfaces:**
- Produces DOM: `#convo` (aside) containing `#presence`, `#presHint`, `#convoLog` > `#convoT` + `#convoQ`, `#msgIn`, `#queueN`, `#sendBtn`, `#sendErr`, `#convoClose`; top-bar `#convoBtn` with `#convoN`. JS: `openConvo()`, `closeConvo()`.

- [ ] **Step 1: Failing check.** Reload the qbot player and run:
`E "JSON.stringify([!!document.querySelector('#convo #sendBtn'), !document.querySelector('.bar #sendBtn'), !document.querySelector('[data-tab=notes]'), document.querySelector('.desk').firstElementChild.className])"` → expected after the task `[true,true,true,"panel"]`; now `[false,false,false,"stage"]`.

- [ ] **Step 2: Markup.** Header: delete the `#waitBadge` span and the `#sendBtn` button; add before `#exportBtn`:

```html
    <button class="btn" id="convoBtn" data-tip="Open the conversation with the agent">Conversation <span class="n" id="convoN">0</span></button>
```

Desk: move `<aside class="panel">…</aside>` to be the first child of `.desk`, and add after `</section>`:

```html
    <aside class="convo" id="convo" aria-label="Conversation">
      <div class="ch"><h2>Conversation</h2><span class="pres off" id="presence"><i></i><span>No agent listening</span></span><button class="btn ghost sm close" id="convoClose" aria-label="Close conversation">×</button></div>
      <div class="hint" id="presHint" hidden>Your feedback waits here. Ask your agent to run <code>motion-os-axi poll &lt;project&gt;</code>.</div>
      <div class="log" id="convoLog"><div id="convoT"></div><div id="convoQ"></div></div>
      <div class="composer">
        <textarea id="msgIn" rows="2" placeholder="Message the agent… Enter queues it, Shift+Enter for a new line"></textarea>
        <div class="row"><span id="queueN">Nothing queued</span><button class="btn primary" id="sendBtn" disabled>Send to Agent</button></div>
        <div class="err" id="sendErr" hidden></div>
      </div>
    </aside>
```

- [ ] **Step 3: CSS.** Change `.desk{...grid-template-columns:minmax(0,1fr) 380px...}` to `grid-template-columns:340px minmax(0,1fr) 360px`. In `.panel{...}` change `border-left:1px solid var(--line)` to `border-right:1px solid var(--line)`. Add after the `.panel` rule:

```css
.convo{background:var(--panel);border-left:1px solid var(--line);min-height:0;display:flex;flex-direction:column}
.ch{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--line)}
.ch h2{margin:0;font-size:14px;flex:1}
.ch .close{display:none}
.pres{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mute);white-space:nowrap}
.pres i{width:8px;height:8px;border-radius:50%;background:var(--faint)}
.pres.on i{background:var(--ok)} .pres.work i{background:var(--pin)}
.hint{margin:10px 14px 0;font-size:12px;color:var(--mute);background:var(--panel-2);border-radius:8px;padding:8px 10px}
.hint code{font-family:var(--mono);font-size:11.5px}
.log{flex:1;min-height:0;overflow:auto;padding:12px 14px;display:grid;gap:10px;align-content:start}
#convoT,#convoQ{display:grid;gap:10px;align-content:start}
.bub{border:1px solid var(--line);border-radius:12px;padding:9px 11px;display:grid;gap:6px;max-width:94%;min-width:0;background:var(--panel)}
.bub.me{justify-self:end;background:var(--accent-soft);border-color:transparent}
.bub.agent{justify-self:start;background:var(--panel-2)}
.bub.q{justify-self:stretch;max-width:none;background:none;border:1.5px dashed var(--line-2)}
.bub.q.sel{border-color:var(--pin)}
.bh{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--mute);list-style:none;min-width:0}
details.bub summary{cursor:pointer;display:grid;gap:4px} details.bub summary::-webkit-details-marker{display:none}
.bh b{color:var(--ink)}
.chip{margin-left:auto;font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:99px;background:var(--panel-2);color:var(--mute);white-space:nowrap}
.chip.picked{background:var(--pin-soft);color:var(--warn)} .chip.done{background:var(--ok-soft);color:var(--ok)}
.bh .go{border:0;background:none;color:var(--accent);padding:0;font-family:var(--mono)} .bh .x{border:0;background:none;color:var(--faint);font-size:15px;padding:0;line-height:1}
.sum{font-size:12.5px} .bub ul,.bub ol{margin:0;padding-left:18px;font-size:12.5px;overflow-wrap:anywhere}
.ql{display:flex;gap:6px;align-items:flex-start;font-size:12.5px}
.qt{border:0;background:none;padding:0;text-align:left;flex:1;min-width:0;overflow-wrap:anywhere;cursor:pointer}
.ql .undo{visibility:visible;flex:none}
.bub textarea{width:100%;border:1px solid var(--line-2);border-radius:7px;padding:6px 8px;background:var(--panel);resize:vertical}
.md{font-size:13px;overflow-wrap:anywhere} .md p{margin:0 0 6px} .md p:last-child{margin:0}
.md pre{margin:0 0 6px;padding:8px;border-radius:7px;background:var(--panel);overflow:auto;font:12px/1.45 var(--mono)} .md code{font-family:var(--mono);font-size:12px}
.composer{border-top:1px solid var(--line);padding:10px 14px 14px;display:grid;gap:8px}
.composer textarea{width:100%;min-height:52px;max-height:160px;resize:vertical;border:1px solid var(--line-2);border-radius:9px;padding:8px 10px;background:var(--panel-2)}
.composer .row{display:flex;align-items:center;gap:8px} .composer .row span{flex:1;font-size:12px;color:var(--mute)}
.composer .err{color:var(--warn);font-size:12px}
#convoBtn{display:none} #convoBtn .n{background:var(--accent);color:var(--accent-ink)}
```

Replace `@media (max-width:1100px){ .desk{grid-template-columns:minmax(0,1fr) 340px} }` with:

```css
@media (max-width:1100px){
  .desk{grid-template-columns:300px minmax(0,1fr)}
  #convoBtn{display:inline-flex}
  .convo{position:fixed;top:0;right:0;bottom:0;width:min(380px,100%);z-index:30;box-shadow:var(--shadow);transform:translateX(105%);transition:transform .2s}
  .convo.open{transform:none}
  .ch .close{display:inline-flex}
}
```

In the `@media (max-width:820px)` block: change `.panel{border-left:0;border-top:1px solid var(--line);overflow:visible}` to `.panel{border-right:0;border-top:1px solid var(--line);overflow:visible;order:2}`, and add `.stage{order:1}` (merge into its existing rule) and:

```css
  .convo{top:auto;left:0;width:100%;height:80vh;height:80dvh;border-radius:14px 14px 0 0;transform:translateY(105%)}
  .convo.open{transform:none}
```

- [ ] **Step 4: JS.** `TABS` → `[['scene','Scene'],['script','Script'],['style','Style'],['media','Media']]`; `renderTabs` → drop the notes-count part (`${l}` only); `renderPane` map → drop `notes:notesPane`; delete `function notesPane(){...}`. Move the note handlers out of `#pane`: delete from the `#pane` click handler the `[data-go-note]` and `[data-del-note]` lines and from the `#pane` input handler the `if (d.noteText) {...}` line (Task 4 re-adds them on `#convo`). Add:

```js
const narrow = () => matchMedia('(max-width:1100px)').matches;
function openConvo(){ if (narrow()) $('#convo').classList.add('open'); }
function closeConvo(){ $('#convo').classList.remove('open'); }
$('#convoBtn').onclick = () => $('#convo').classList.toggle('open');
$('#convoClose').onclick = closeConvo;
```

In the global keydown handler's Escape branch add `closeConvo();`. Replace `focusNote` with:

```js
function focusNote(id){ const n = st.notes.find(n => n.id === id); ui.selNote = id; pause(); seek(n.t); openConvo(); renderQueue();
  document.querySelector(`[data-note-bub="${id}"]`)?.scrollIntoView({block:'nearest', behavior:'smooth'}); }
```

Add a temporary `function renderQueue(){}` (Task 4 replaces it), and in `markDirty` replace the `#sendN` line with `$('#convoN').textContent = queueCount();` plus `const queueCount = () => pendingEdits() + openNotes().length + (st.messages?.length || 0);` next to `pendingEdits`. Delete `checkWaiting` and its two calls (`checkWaiting();` before the interval and `checkWaiting() ||` inside it), and in `sendFeedback` remove `checkWaiting();`.

- [ ] **Step 5: Check.** Reload; the Step 1 check → `[true,true,true,"panel"]`; `T` → `selftest ok`. Screenshots:

```bash
for v in "1400x800x1" "1000x760x1" "390x844x2,mobile,touch"; do chrome-devtools-axi emulate --viewport "$v" >/dev/null; chrome-devtools-axi open $URL >/dev/null 2>&1; sleep 2
  E "(() => { document.querySelector('#convoBtn').offsetParent && document.querySelector('#convoBtn').click(); return JSON.stringify([innerWidth, document.documentElement.scrollWidth, document.querySelector('#sendBtn').getBoundingClientRect().bottom <= innerHeight]); })()"
  sleep 0.5; chrome-devtools-axi screenshot $S/conv-${v%%x*}.png >/dev/null 2>&1; done
chrome-devtools-axi emulate --viewport "1400x800x1" >/dev/null
```

Expected each: `scrollWidth <= innerWidth`, send button visible (true). Read the three screenshots: three columns at 1400; drawer over the right at 1000; bottom sheet at 390 (Review Focus 5).

- [ ] **Step 6: Checkpoint.**

---

### Task 4: Conversation content — queue, composer, transcript, markdown, presence

**Files:** Modify `player/index.html`: state defaults (`st = Object.assign(...)` ~380), `feedback()`/`sendFeedback()` (~905-927), the `#pane` click `[data-undo]` branch (extract `undoPath`), `changed()` and `renderAll()`, intervals at load (~1100), `selftest()`.

**Interfaces:**
- Consumes: Task 3 DOM, `editRow`, `openNotes`, `queueCount`, Task 2 `/transcript`.
- Produces: `st.messages: {id, text}[]`; `undoPath(path)`; `renderQueue()`; `renderTranscript()`; `pollTranscript(): Promise`; `md(text): string`; `convo = {entries, presence, waiting, sending, sig}`.

- [ ] **Step 1: Failing tests.** In `selftest()`, extend the first state snapshot line (`const saved = JSON.stringify(st.over), ...`) with `savedQ = JSON.stringify({notes: st.notes, messages: st.messages, sent: st.sent, sentSnap: st.sentSnap, links: st.links})`, and in the `finally` add `Object.assign(st, JSON.parse(savedQ));` before `markDirty()`. Before `} finally` add:

```js
    // conversation pane: the queue mirrors the unsent state
    st.over = {}; st.sentSnap = {}; st.sent = []; st.links = [];
    st.notes = [{id: 501, t: s1.t[0] + 0.2, x: 10, y: 10, el: null, text: 'a'}, {id: 502, t: s1.t[0] + 0.4, x: 20, y: 20, el: null, text: 'b'}];
    st.messages = [{id: 1, text: 'make it faster'}];
    const te = allEls().find(x => Object.values(x.props).some(p => p.type === 'text')), tk = Object.keys(te.props).find(k => te.props[k].type === 'text');
    set(`${te.id}.${tk}`, 'New words', te.props[tk].v); set(`${s0.id}.@len`, L0, O0); renderQueue();
    const q = document.querySelector('#convoQ');
    eq([q.querySelectorAll('.ql').length, q.querySelectorAll('[data-note-bub]').length, q.querySelectorAll('[data-msg]').length, q.querySelectorAll('[data-trim-bub]').length], [1, 2, 1, 1], 'one Changes line, two notes, one message, one trim');
    eq([...q.querySelectorAll('[data-note-bub] .num')].map(x => x.textContent), ['1', '2'], 'note bubbles carry the pin number');
    q.querySelector(`.ql [data-undo="${te.id}.${tk}"]`).click();
    eq(`${te.id}.${tk}` in st.over, false, 'Undo on a Changes line removes that edit');
    eq(feedback().messages, ['make it faster'], 'messages go in the payload');
    // typing in a queued note survives a transcript refresh
    const ta = document.querySelector('[data-note-text="501"]'); ta.focus();
    convo.sig = ''; renderTranscript([{id: 'x', at: new Date().toISOString(), role: 'agent', text: 'hello'}], 'listening', 0);
    eq(document.activeElement === document.querySelector('[data-note-text="501"]'), true, 'refresh keeps focus in a queued note');
    // markdown subset, HTML stays text
    eq(md('<img src=x onerror=alert(1)>').includes('<img'), false, 'markdown escapes HTML');
    eq(md('**a** `b`\n\n- x\n- y'), '<p><b>a</b> <code>b</code></p><ul><li>x</li><li>y</li></ul>', 'markdown subset');
    // double-click sends one batch; success empties the queue
    let posts = 0; const rf = window.fetch;
    window.fetch = async (u, o) => { if (o?.method === 'POST') { posts++; await new Promise(r => setTimeout(r, 50)); } return {ok: true, json: async () => ({entries: [], presence: 'idle', waiting: 0})}; };
    try { await Promise.all([sendFeedback(), sendFeedback()]); } finally { window.fetch = rf; }
    eq([posts, st.messages.length, queueCount()], [1, 0, 0], 'one send, queue emptied');
```

- [ ] **Step 2: Run, expect fail.** Reload qbot player, `T` → `FAIL ... one Changes line, two notes, ...` (empty queue from the Task 3 stub).

- [ ] **Step 3: Implement.**

State: in `st = Object.assign({over:{}, notes:..., ...}, st || {})` add `messages:[]` to the defaults.

Extract undo: in the `#pane` click handler replace the `[data-undo]` branch with `if (b = q('[data-undo]')) return undoPath(b.dataset.undo);` and add:

```js
function undoPath(path){ const t0 = now(); delete st.over[path]; if (path.endsWith('.@len')) seek(t0);
  if (path === 'audio.music' || path === 'brand.logo') setupMusic(); renderPane(); changed(); }
```

Make `changed()` also call `renderQueue()`, and `renderAll()` call `renderQueue()` after `renderHots()`.

`feedback()`: add `messages: (st.messages || []).map(m => m.text),` before `scenes`.

Replace `sendFeedback` with:

```js
async function sendFeedback(){
  if (convo.sending) return;
  if (!queueCount()) return toast('Nothing to send yet. Edit something, press N to pin a note, or type a message.');
  convo.sending = true; renderQueue(); $('#sendErr').hidden = true;
  try {
    const r = await fetch('feedback', {method: 'POST', body: JSON.stringify(feedback())});
    if (!r.ok) throw new Error(`the player server answered ${r.status}`);
    st.sent = [...new Set([...st.sent, ...openNotes().map(n => n.id)])]; st.sentSnap = JSON.parse(JSON.stringify(st.over)); st.links.forEach(l => l.sent = true); st.messages = [];
    convo.sending = false; renderAll(); toast('Sent to the agent'); pollTranscript();
  } catch (e) { convo.sending = false; $('#sendErr').textContent = `Couldn't send: ${e.message}. Your queue is kept.`; $('#sendErr').hidden = false; renderQueue(); }
}
```

Replace the Task 3 stub `function renderQueue(){}` with the conversation code:

```js
/* ================= conversation pane ================= */
let convo = {entries: [], presence: 'idle', waiting: 0, sending: false, sig: ''};
const tm = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}); };
const cut = s => { s = String(s ?? ''); return s.length > 80 ? s.slice(0, 80) + '…' : s; };
const inlineMd = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>')
  .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
function md(src){
  return String(src ?? '').split('```').map((b, i) => i % 2 ? `<pre><code>${esc(b.replace(/^[\w-]*\n/, ''))}</code></pre>`
    : b.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => { const ls = p.split('\n');
        if (ls.every(l => /^\s*[-*] /.test(l))) return `<ul>${ls.map(l => `<li>${inlineMd(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
        if (ls.every(l => /^\s*\d+\. /.test(l))) return `<ol>${ls.map(l => `<li>${inlineMd(l.replace(/^\s*\d+\. /, ''))}</li>`).join('')}</ol>`;
        return `<p>${ls.map(l => /^#{1,6} /.test(l) ? `<b>${inlineMd(l.replace(/^#+ /, ''))}</b>` : inlineMd(l)).join('<br>')}</p>`; }).join('')).join('');
}
function batchList(b){
  const li = [...(b.edits || []).map(e => `${e.element} · ${e.field}: ${cut(e.from)} → ${cut(e.to)}`), ...(b.notes || []).map(n => `Note ${n.n} at ${fmt(n.t)}: ${cut(n.text)}`),
    ...(b.trims || []).map(t => `Trim ${t.scene}: ${t.from}s → ${t.to}s`), ...(b.links || []).map(l => `Link ${l}`), ...(b.messages || []).map(m => `“${cut(m)}”`)];
  return li.length ? `<ul>${li.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
}
function entryHTML(e){
  if (e.role === 'agent') return `<div class="bub agent"><div class="bh"><b>Agent</b><span class="mono">${tm(e.at)}</span></div><div class="md">${md(e.text)}</div></div>`;
  const b = e.batch || {}, parts = [['change', b.edits], ['note', b.notes], ['trim', b.trims], ['link', b.links], ['message', b.messages]].filter(([, a]) => a?.length).map(([w, a]) => `${a.length} ${w}${a.length > 1 ? 's' : ''}`);
  return `<details class="bub me"><summary><span class="bh"><b>You</b><span class="mono">${tm(e.at)}</span><span class="chip ${e.status || 'sent'}">${({picked: 'Picked up', done: 'Done'})[e.status] || 'Sent'}</span></span><span class="sum">${esc(parts.join(', ') || 'Empty send')}</span></summary>${batchList(b)}</details>`;
}
// The transcript and the queue are separate containers: a refresh rewrites #convoT only, so typing in #convoQ is never lost.
function renderTranscript(entries, presence, waiting){
  const sig = JSON.stringify([entries, presence, waiting]); if (sig === convo.sig) return; convo.sig = sig;
  Object.assign(convo, {entries, presence, waiting});
  const log = $('#convoLog'), atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  $('#convoT').innerHTML = entries.map(entryHTML).join('');
  renderPresence(); if (atEnd) log.scrollTop = log.scrollHeight;
}
function renderPresence(){
  const p = convo.presence, [cls, label] = p === 'listening' ? ['on', 'Agent listening'] : p === 'working' ? ['work', 'Agent working'] : ['off', 'No agent listening'];
  $('#presence').className = 'pres ' + cls; $('#presence span').textContent = label;
  $('#presHint').hidden = !(p === 'idle' && (queueCount() || convo.waiting));
}
function renderQueue(){
  if (!P || !st) return;
  const fresh = ([k, v]) => JSON.stringify(st.sentSnap[k]) !== JSON.stringify(v), over = Object.entries(st.over).filter(fresh);
  const edits = over.filter(([k]) => !k.endsWith('.@len')), trims = over.filter(([k]) => k.endsWith('.@len')), lab = convo.sending ? 'Sending' : 'Queued', out = [];
  if (edits.length) out.push(`<div class="bub q"><div class="bh"><b>${edits.length} change${edits.length > 1 ? 's' : ''}</b><span class="chip">${lab}</span></div>${edits.map(([k, v]) => { const r = editRow(k, v);
    return `<div class="ql"><button class="qt" data-qsel="${esc(k.split('.')[0])}">${esc(r.element)} · ${esc(r.field)}: ${esc(cut(r.from))} → ${esc(cut(r.to))}</button><button class="undo" data-undo="${esc(k)}">Undo</button></div>`; }).join('')}</div>`);
  for (const n of openNotes()) { const i = st.notes.indexOf(n) + 1, e = n.el && elById(n.el);
    out.push(`<div class="bub q ${ui.selNote === n.id ? 'sel' : ''}" data-note-bub="${n.id}"><div class="bh"><span class="num">${i}</span><button class="go" data-go-note="${n.id}">${fmt(toEd(n.t))}</button><span>${esc(e ? e.label : sceneAt(n.t).name)}</span>${isCut(n.t) ? '<span class="tag">Cut</span>' : ''}<span class="chip">${lab}</span><button class="x" data-del-note="${n.id}" aria-label="Delete note">×</button></div><textarea data-note-text="${n.id}" rows="2">${esc(n.text)}</textarea></div>`); }
  for (const [k] of trims) { const s = sceneOf(k.split('.')[0]);
    out.push(`<div class="bub q" data-trim-bub="${s.id}"><div class="bh"><b>Trim ${esc(s.id)}</b><span>${(s.t[1] - s.t[0]).toFixed(1)}s → ${sceneLen(s).toFixed(1)}s</span><span class="chip">${lab}</span><button class="undo" style="visibility:visible" data-undo="${esc(k)}">Undo</button></div></div>`); }
  st.links.forEach((l, i) => { if (!l.sent) out.push(`<div class="bub q"><div class="bh"><b>Link</b><span class="mono" style="overflow:hidden;text-overflow:ellipsis">${esc(l.url)}</span><span class="chip">${lab}</span><button class="x" data-del-link="${i}" aria-label="Remove link">×</button></div></div>`); });
  (st.messages || []).forEach(m => out.push(`<div class="bub q" data-msg="${m.id}"><div class="bh"><b>Message</b><span class="chip">${lab}</span><button class="x" data-del-msg="${m.id}" aria-label="Remove message">×</button></div><div class="md">${md(m.text)}</div></div>`));
  $('#convoQ').innerHTML = out.join('');
  const n = queueCount(); $('#queueN').textContent = n ? `${n} queued` : 'Nothing queued';
  $('#sendBtn').disabled = !n || convo.sending; $('#sendBtn').textContent = convo.sending ? 'Sending…' : 'Send to Agent';
  renderPresence();
}
function pollTranscript(){
  return fetch('transcript').then(r => r.json()).then(j => renderTranscript(j.entries || [], j.presence || 'idle', j.waiting || 0)).catch(() => {});
}
$('#convo').addEventListener('click', ev => {
  const q = s => ev.target.closest(s); let b;
  if (b = q('[data-undo]')) return undoPath(b.dataset.undo);
  if (b = q('[data-qsel]')) { const e = elById(b.dataset.qsel); if (e) { setMode('edit'); selectEl(e.id); } return; }
  if (b = q('[data-go-note]')) return focusNote(+b.dataset.goNote);
  if (b = q('[data-del-note]')) { st.notes = st.notes.filter(n => n.id !== +b.dataset.delNote); markDirty(); return renderAll(); }
  if (b = q('[data-del-link]')) { st.links.splice(+b.dataset.delLink, 1); markDirty(); return renderAll(); }
  if (b = q('[data-del-msg]')) { st.messages = st.messages.filter(m => m.id !== +b.dataset.delMsg); markDirty(); return renderQueue(); }
});
$('#convo').addEventListener('input', ev => { const d = ev.target.dataset; if (d.noteText) { st.notes.find(n => n.id === +d.noteText).text = ev.target.value; markDirty(); } });
$('#msgIn').addEventListener('keydown', ev => {
  if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
  ev.preventDefault(); const text = ev.target.value.trim(); if (!text) return;
  st.messages = [...(st.messages || []), {id: Date.now(), text}]; ev.target.value = ''; markDirty(); renderQueue();
  $('#convoLog').scrollTop = $('#convoLog').scrollHeight;
});
$('#sendBtn').onclick = sendFeedback;
```

Remove the old `$('#sendBtn').onclick = sendFeedback;` line (it was for the top-bar button). At load, after `loadProject();` add `pollTranscript(); setInterval(pollTranscript, 2000);`.

- [ ] **Step 4: Run, expect pass.** Reload qbot player: `T` → `selftest ok`. Also check Herdcats' page renders (open `http://localhost:4321` read-only and run `T`; do not Send or poll there).

- [ ] **Step 5: Browser E2E on qbot-tag.**

```bash
E "(() => { localStorage.clear(); location.reload(); return 1; })()"; sleep 3
E "(() => { const e = allEls().find(x => Object.values(x.props).some(p => p.type === 'text')); const k = Object.keys(e.props).find(k => e.props[k].type === 'text');
  set(e.id + '.' + k, 'Changed, again', e.props[k].v); st.notes.push({id: 99, t: 3.2, x: 40, y: 50, el: null, text: 'Slower here'}); renderAll(); return 1; })()"
E "(() => { const m = document.querySelector('#msgIn'); m.value = 'Make the whole thing 10% faster'; m.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); return document.querySelector('#queueN').textContent; })()"
chrome-devtools-axi screenshot $S/conv-queued.png
node bin/motion-os-axi.mjs poll examples/qbot-tag --timeout 30 > $MOTION_OS_AXI_HOME/p.out &   # tracked background job
sleep 1; E "(() => document.querySelector('#presence').textContent)()"           # Agent listening
E "(async () => { await sendFeedback(); return document.querySelector('#queueN').textContent; })()"   # Nothing queued
wait; grep -E "^counts|^messages|Changed, again|Slower here" $MOTION_OS_AXI_HOME/p.out
sleep 2; E "(() => [document.querySelector('#presence').textContent, document.querySelector('#convoT .chip')?.textContent].join(' | '))()"   # Agent working | Picked up
node bin/motion-os-axi.mjs poll examples/qbot-tag --reply 'Done: changed the title and **slowed** scene 1. See `S1`.' --timeout 3
sleep 2; E "(() => [document.querySelector('#convoT .chip')?.textContent, document.querySelector('#convoT .agent .md')?.innerHTML].join(' | '))()"   # Done | <p>Done: ... <b>slowed</b> ... <code>S1</code>.</p>
chrome-devtools-axi screenshot $S/conv-replied.png
```

Expected as commented; poll output has `counts: edits=1 notes=2 trims=0 links=0 messages=1` (qbot ships an example note), the `messages[1]` line and both texts. Read both screenshots: queued dashed bubbles + composer, then a "You" bubble marked Done and an "Agent" bubble with bold and code. Clean up: `E "(() => { localStorage.clear(); return 1; })()"`, `node bin/motion-os-axi.mjs stop`, `rm -f examples/qbot-tag/.motion-os-axi/transcript.json examples/qbot-tag/.motion-os-axi/inbox.json`.

- [ ] **Step 6: Checkpoint.**

---

### Task 5: SKILL.md, Herdcats scripts, full regression

**Files:** Modify `SKILL.md`; `/Users/zhiyaochan/Projects/ios-app/herdcats-launch-video/bin/start-motion-os-axi`, `bin/monitor-motion-os-axi`.

- [ ] **Step 1: SKILL.md.**
- Step 5 "Then tell the user" paragraph: replace `press N to pin a note,` with `press N to pin a note (notes appear in the Conversation pane on the right, where they can also type messages),` and `and when they're done, click **Send to Claude**.` with `and when they're done, click **Send to Agent** at the bottom of the Conversation pane.`
- Step 6: replace the final bullet `- Reply with a short list of what changed and anything you couldn't do.` with ``- Finish with `motion-os-axi poll <project> --reply "<short summary of what changed and anything you couldn't do>"`. The reply shows in the user's Conversation pane, and the same command waits for their next Send.``
- In Step 6's opening paragraph replace `It prints the user's edits, notes, trims, links and scene statuses as rows;` with `It prints the user's messages, edits, notes, trims, links and scene statuses as rows;`.

- [ ] **Step 2: Herdcats scripts.** In both scripts, replace loop steps 3–4:

```
3. Save its output to .motion-os-axi/applied/<date-time>.txt, then apply it the way the skill says: read any messages first, look at each note's frame, leave approved scenes alone, apply trims last. Re-render, run check, and set reel.json \"version\" to what poll asks for.
4. Reply in the player's Conversation pane and keep listening in one step: run \`$AXI poll $DIR --reply \"<a few lines: what you changed, anything you couldn't do>\"\` as a background job. It returns at my next Send; go back to step 3.
```

and change step 2's sentence to "Run `$AXI poll $DIR` as a background job and wait for it to finish (first round only; later rounds start from step 4)." Run `bash -n` on both and the stub dry-run from before (`PATH` with a fake `claude` printing `$1 | head -12`).

- [ ] **Step 3: Regression.** `node bin/motion-os-axi.mjs --selftest`, `node player/serve.mjs --selftest`, `node bin/motion-os-axi.mjs check examples/qbot-tag`, player `T` on qbot, `git diff --stat`.

- [ ] **Step 4: Checkpoint.** Ask the user before committing.
