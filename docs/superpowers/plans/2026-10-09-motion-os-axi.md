# motion-os-axi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `bin/motion-os-axi.mjs`, a zero-dependency AXI CLI for Motion OS (status, open, check, poll, frame, export, stop, setup-hook), and make the player's Send deliver structured feedback to `poll` instead of a copy-paste prompt.

**Architecture:** Small focused modules in `bin/`: `toon.mjs` (output encoding), `check.mjs` (reel.json validation, pure core + fs wrapper), `store.mjs` (player registry in `~/.motion-os/players.json` and per-project feedback queue in `<project>/.motion-os/inbox.json`), `format.mjs` (turns feedback batches into TOON), and `motion-os-axi.mjs` (commands). `player/serve.mjs` gains `/feedback` and `/poll` endpoints and registers itself; the player builds a `feedback()` payload and POSTs it.

**Tech Stack:** Node 18+ built-ins only (`node:http`, `node:fs`, `node:child_process`, global `fetch`); ffmpeg/ffprobe optional; the player stays one HTML file.

**Spec:** `docs/specs/2026-10-09-motion-os-axi-design.md`

## Global Constraints

- Zero dependencies. Run as `node "$SKILL_DIR/bin/motion-os-axi.mjs"`. Not published to npm.
- Send delivers to `poll` only; the copy-paste prompt sheet is removed.
- stdout is TOON only; logs and debug go to stderr or `<project>/.motion-os/server.log`. Nothing prompts interactively.
- Errors: `error: <code>` + `message: <text>`, exit 1; unknown command/flag: `error: usage`, exit 2.
- Text fields truncate at 120 chars with `…(+N chars)`; `--full` disables truncation.
- Every output ends with `help[N]:` next-step lines using `<project>` / `<t>` placeholders.
- Registry path `~/.motion-os/players.json`, overridable with env `MOTION_OS_HOME` (tests use a temp dir).
- POSTs to the server accept only `localhost`/`127.0.0.1` origins (as `/export` does).
- `node player/serve.mjs <project>` must keep working on its own.
- Commits only when the user okays them (they approved commits for the previous batch; ask again at the end).

## Review Focus

1. Feedback lost between drain and delivery: the server must not clear the queue if the poll connection already closed. (Task 3 Step 1 queue test + Task 3 server guard.)
2. Two `poll`s waiting at once: each batch goes to exactly one of them, never both, never neither. (Task 3 Step 1.)
3. A stale registry entry (player killed with `kill -9`): status/open must ignore it and `open` must start a fresh server. (Task 4 Step 1.)
4. Values containing commas, colons, quotes or newlines (note text, copy) must stay one TOON cell. (Task 1 Step 1.)
5. Send pressed with the server down: nothing is marked sent, and the edits stay pending. (Task 5 Step 1.)

---

## File Structure

- Create `bin/toon.mjs`, `bin/check.mjs`, `bin/store.mjs`, `bin/format.mjs`, `bin/motion-os-axi.mjs`, `bin/selftest.mjs` (all checks for `--selftest`).
- Modify `player/serve.mjs` (registry, `/feedback`, `/poll`), `player/index.html` (`feedback()`, Send, waiting badge, remove `prompt()`/`describe()`), `SKILL.md`.

Shell helpers used below:

```bash
cd /Users/zhiyaochan/Projects/skills/motion-os
AXI="node bin/motion-os-axi.mjs"
export MOTION_OS_HOME=$(mktemp -d)        # keep tests out of the real registry until Task 6
export CHROME_DEVTOOLS_AXI_SESSION=motionos
E() { chrome-devtools-axi eval "$1" 2>&1 | head -1; }
```

---

### Task 1: TOON encoder and the selftest harness

**Files:** Create `bin/toon.mjs`, `bin/selftest.mjs`, `bin/motion-os-axi.mjs` (only `--selftest` for now).

**Interfaces:**
- Produces: `val(v): string`, `toon(obj): string` (keys in insertion order), `trunc(s, full, n = 120): string`; `selftest(): void` (throws on failure); `eq(a, b, msg)` exported from `selftest.mjs` for later tasks' checks.

- [ ] **Step 1: Failing tests** — `bin/selftest.mjs`:

```js
// Checks for `motion-os-axi --selftest`. Each task adds its own section.
import {toon, val, trunc} from './toon.mjs';

export const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

export async function selftest(){
  // toon
  eq(val('plain words'), 'plain words', 'bare string');
  eq([val('a,b'), val('x: y'), val('say "hi"'), val('two\nlines'), val(''), val(' pad')], ['"a,b"', '"x: y"', '"say \\"hi\\""', '"two\\nlines"', '""', '" pad"'], 'quoted strings');
  eq([val(3), val(1.5), val(true), val(null), val(undefined)], ['3', '1.5', 'true', 'null', 'null'], 'scalars');
  eq(toon({a: 1, b: 'x'}), 'a: 1\nb: x', 'scalars object');
  eq(toon({l: ['x', 'y,z']}), 'l[2]: x,"y,z"', 'scalar list');
  eq(toon({r: [{id: 1, t: 'a'}, {id: 2, t: 'b, c', more: 9}]}), 'r[2]{id,t,more}:\n  1,a,null\n  2,"b, c",9', 'object rows use the union of keys');
  eq(toon({r: []}), 'r[0]:', 'empty list');
  eq(trunc('x'.repeat(130), false), 'x'.repeat(120) + '…(+10 chars)', 'truncates');
  eq(trunc('x'.repeat(130), true).length, 130, '--full keeps everything');
}
```

`bin/motion-os-axi.mjs` (first version):

```js
#!/usr/bin/env node
// motion-os-axi: the agent-facing CLI for Motion OS (https://axi.md). Zero dependencies.
import {selftest} from './selftest.mjs';

const args = process.argv.slice(2);
if (args[0] === '--selftest') {
  try { await selftest(); console.log('selftest ok'); }
  catch (e) { console.log(`error: selftest\nmessage: ${e.message}`); process.exit(1); }
  process.exit(0);
}
```

- [ ] **Step 2: Run, expect fail.** `node bin/motion-os-axi.mjs --selftest` → error importing `./toon.mjs` (module not found).

- [ ] **Step 3: Implement** `bin/toon.mjs`:

```js
// Minimal TOON encoder for motion-os-axi output: `key: value`, `key[N]: a,b`, `key[N]{f,g}:` + indented rows.
const QUOTE = /[,:"\n\r]|^\s|\s$/;

export function val(v){
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return s === '' || QUOTE.test(s) ? JSON.stringify(s) : s;
}

export function toon(obj){
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) { out.push(`${k}: ${val(v)}`); continue; }
    if (!v.length) { out.push(`${k}[0]:`); continue; }
    if (v.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      const fields = [...new Set(v.flatMap(Object.keys))];
      out.push(`${k}[${v.length}]{${fields.join(',')}}:`);
      for (const row of v) out.push('  ' + fields.map(f => val(row[f])).join(','));
    } else out.push(`${k}[${v.length}]: ${v.map(val).join(',')}`);
  }
  return out.join('\n');
}

export const trunc = (s, full, n = 120) => { s = String(s ?? ''); return full || s.length <= n ? s : s.slice(0, n) + `…(+${s.length - n} chars)`; };
```

- [ ] **Step 4: Run, expect pass.** `node bin/motion-os-axi.mjs --selftest` → `selftest ok`.

- [ ] **Step 5: Checkpoint.** `git status --short` shows the three new files.

---

### Task 2: `check` — reel.json validation

**Files:** Create `bin/check.mjs`; modify `bin/selftest.mjs`, `bin/motion-os-axi.mjs`.

**Interfaces:**
- Produces: `checkReelData(reel, {exists, mp4Duration}): Problem[]` (pure), `checkReel(dir): {reel, problems}` (reads files, runs ffprobe if available), `Problem = {level: 'error'|'warn', where, message}`; CLI helpers `out(obj)`, `fail(code, message, help)`, `usage(message)` in `motion-os-axi.mjs`.

- [ ] **Step 1: Failing tests.** Append to `selftest()` in `bin/selftest.mjs` (and add `import {checkReelData} from './check.mjs';` at the top):

```js
  // check
  const good = () => ({id: 'x', version: 1, src: 'v.mp4', fps: 30, duration: 10, assets: [{id: 'assets/a.png'}],
    scenes: [{id: 'S1', t: [0, 4], els: [{id: 'a', t: [0, 4], box: [10, 10, 50, 50], props: {img: {type: 'media', v: 'assets/a.png'}}}]},
             {id: 'S2', t: [4, 10], els: [{id: 'b', t: [5, 9], box: null, props: {}}]}]});
  const msgs = (r, o) => checkReelData(r, {exists: () => true, ...o}).map(p => `${p.level} ${p.where}: ${p.message}`);
  eq(msgs(good()), [], 'good reel has no problems');
  let r = good(); delete r.fps; eq(msgs(r), ['error reel: missing "fps"'], 'missing field');
  r = good(); r.scenes[0].t = [0.5, 4]; eq(msgs(r), ['error S1: starts at 0.5s, not 0'], 'first scene start');
  r = good(); r.scenes[1].t = [5, 10]; eq(msgs(r)[0], 'error S2: gap after S1 (4s to 5s)', 'gap');
  r = good(); r.scenes[1].t = [3, 10]; eq(msgs(r)[0], 'error S2: overlaps S1 (starts 3s, S1 ends 4s)', 'overlap');
  r = good(); r.duration = 12; eq(msgs(r), ['error S2: ends at 10s but duration is 12s'], 'end vs duration');
  r = good(); r.scenes[1].els[0].id = 'a'; eq(msgs(r), ['error a: duplicate id'], 'duplicate id');
  r = good(); r.scenes[0].els[0].box = [60, 10, 50, 50]; eq(msgs(r), ['error a: box [60,10,50,50] is not [x, y, w, h] inside 0-100'], 'box outside');
  r = good(); r.scenes[1].els[0].t = [3, 9]; eq(msgs(r), ['error b: time 3-9s is outside S2 (4-10s)'], 'element time outside scene');
  r = good(); eq(msgs(r, {exists: p => p !== 'assets/a.png'}), ['error a: img: file assets/a.png not found', 'error assets: assets/a.png not found'], 'missing file');
  r = good(); eq(msgs(r, {mp4Duration: 10.3}), ['warn reel: duration 10s but v.mp4 is 10.30s'], 'mp4 duration');
  r = good(); r.live = 'live.js'; r.export = {}; eq(msgs(r, {exists: p => p !== 'live.js'}), ['warn reel: live bundle live.js not found', 'warn reel: export has no cmd'], 'live and export');
```

- [ ] **Step 2: Run, expect fail.** `$AXI --selftest` → module `./check.mjs` not found.

- [ ] **Step 3: Implement** `bin/check.mjs`:

```js
// reel.json validation for `motion-os-axi check`. checkReelData is pure; checkReel reads the project folder.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export function checkReelData(r, {exists = () => true, mp4Duration = null} = {}){
  const P = [], err = (where, message) => P.push({level: 'error', where, message}), warn = (where, message) => P.push({level: 'warn', where, message});
  for (const k of ['id', 'version', 'src', 'fps', 'duration', 'scenes']) if (r[k] == null) err('reel', `missing "${k}"`);
  if (!Array.isArray(r.scenes)) return P;
  const tol = 1 / (r.fps || 30) + 1e-6, ids = new Set(), seen = id => { if (ids.has(id)) err(id, 'duplicate id'); ids.add(id); };
  r.scenes.forEach((s, i) => {
    seen(s.id);
    const prev = r.scenes[i - 1];
    if (i === 0 && Math.abs(s.t[0]) > tol) err(s.id, `starts at ${s.t[0]}s, not 0`);
    if (prev && s.t[0] - prev.t[1] > tol) err(s.id, `gap after ${prev.id} (${prev.t[1]}s to ${s.t[0]}s)`);
    if (prev && prev.t[1] - s.t[0] > tol) err(s.id, `overlaps ${prev.id} (starts ${s.t[0]}s, ${prev.id} ends ${prev.t[1]}s)`);
    for (const e of s.els || []) {
      seen(e.id);
      const b = e.box;
      if (b != null && !(Array.isArray(b) && b.length === 4 && b.every(n => typeof n === 'number' && n >= 0 && n <= 100) && b[0] + b[2] <= 100.5 && b[1] + b[3] <= 100.5))
        err(e.id, `box ${JSON.stringify(b)} is not [x, y, w, h] inside 0-100`);
      if (Array.isArray(e.t) && (e.t[0] < s.t[0] - tol || e.t[1] > s.t[1] + tol)) err(e.id, `time ${e.t[0]}-${e.t[1]}s is outside ${s.id} (${s.t[0]}-${s.t[1]}s)`);
      for (const [k, p] of Object.entries(e.props || {}))
        if (p.type === 'media' && typeof p.v === 'string' && p.v.includes('/') && !exists(p.v)) err(e.id, `${k}: file ${p.v} not found`);
    }
  });
  const last = r.scenes[r.scenes.length - 1];
  if (last && r.duration != null && Math.abs(last.t[1] - r.duration) > tol) err(last.id, `ends at ${last.t[1]}s but duration is ${r.duration}s`);
  if (r.src && !exists(r.src)) err('reel', `src ${r.src} not found`);
  for (const a of r.assets || []) if (a.id.includes('/') && !exists(a.id)) err('assets', `${a.id} not found`);
  if (mp4Duration != null && r.duration != null && Math.abs(mp4Duration - r.duration) > 0.1) warn('reel', `duration ${r.duration}s but ${r.src} is ${mp4Duration.toFixed(2)}s`);
  if (r.live && !exists(r.live)) warn('reel', `live bundle ${r.live} not found`);
  if (r.export && !r.export.cmd) warn('reel', 'export has no cmd');
  return P;
}

function probe(file){
  try { return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()) || null; }
  catch { return null; }
}

export function checkReel(dir){
  const file = path.join(dir, 'reel.json');
  if (!fs.existsSync(file)) return {reel: null, problems: [{level: 'error', where: 'reel', message: `no reel.json in ${dir}`}]};
  let reel;
  try { reel = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return {reel: null, problems: [{level: 'error', where: 'reel', message: `reel.json is not valid JSON: ${e.message}`}]}; }
  const exists = p => fs.existsSync(path.join(dir, p)) || fs.existsSync(path.join(dir, 'public', p));
  const mp4Duration = reel.src && exists(reel.src) ? probe(path.join(dir, reel.src)) : null;
  return {reel, problems: checkReelData(reel, {exists, mp4Duration})};
}
```

- [ ] **Step 4: Run, expect pass.** `$AXI --selftest` → `selftest ok`.

- [ ] **Step 5: Add the CLI frame and `check`.** Replace `bin/motion-os-axi.mjs` with:

```js
#!/usr/bin/env node
// motion-os-axi: the agent-facing CLI for Motion OS (https://axi.md). Zero dependencies.
// stdout is TOON; every output ends with help[] next steps; errors exit 1, usage errors exit 2.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {toon} from './toon.mjs';
import {checkReel} from './check.mjs';
import {selftest} from './selftest.mjs';

const BIN = fileURLToPath(import.meta.url), AXI = `node ${BIN}`;
const argv = process.argv.slice(2), flags = new Set(argv.filter(a => a.startsWith('--'))), pos = argv.filter(a => !a.startsWith('--'));
const optVal = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
export const full = flags.has('--full');

export function out(obj, help = []){ console.log(toon({...obj, ...(help.length ? {help} : {})})); }
export function fail(code, message, help = []){ out({error: code, message}, help); process.exit(1); }
function usage(message){ out({error: 'usage', message}, [`Run \`${AXI} --help\``]); process.exit(2); }
const projectDir = p => path.resolve(p || '.');

const COMMANDS = {
  check: {usage: 'check <project>', about: 'Validate reel.json: scene timing, ids, boxes, files, duration', flags: [], run: cmdCheck},
};

function cmdCheck(){
  const dir = projectDir(pos[1]), {problems} = checkReel(dir), errors = problems.filter(p => p.level === 'error').length;
  out({project: dir, problems: problems.length, errors, ...(problems.length ? {problems} : {})},
    errors ? ['Fix the errors in reel.json (or the render), then run `' + AXI + ' check <project>` again']
           : [`Run \`${AXI} open <project>\` to review it in the player`]);
  if (errors) process.exit(1);
}

if (argv[0] === '--selftest') {
  try { await selftest(); console.log('selftest ok'); } catch (e) { out({error: 'selftest', message: e.message}); process.exit(1); }
  process.exit(0);
}
const cmd = pos[0] && COMMANDS[pos[0]];
if (pos[0] && !cmd) usage(`unknown command "${pos[0]}"`);
if (cmd) {
  const known = new Set(['--help', '--full', ...cmd.flags]);
  for (const f of flags) if (!known.has(f)) usage(`unknown flag ${f} for ${pos[0]}`);
  if (flags.has('--help')) { out({usage: `${AXI} ${cmd.usage}`, about: cmd.about, flags: [...cmd.flags, '--full']}); process.exit(0); }
  await cmd.run();
}
```

(`problems` prints as rows only when there are any; `problems: 0` is the explicit empty state.) The no-argument and `--help` root behaviour come in Task 4.

- [ ] **Step 6: Run on real projects.**

```bash
$AXI check examples/qbot-tag; echo "exit $?"
$AXI check /Users/zhiyaochan/Projects/ios-app/herdcats-launch-video; echo "exit $?"
T=$(mktemp -d); cp examples/qbot-tag/reel.json $T/; $AXI check $T; echo "exit $?"
$AXI check --bogus; echo "exit $?"
```

Expected: qbot-tag `problems: 0` exit 0. Herdcats: no errors, exit 0 (a `warn` about duration is acceptable). The temp copy reports `src video.mp4 not found` and the missing asset files, exit 1. `--bogus` → `error: usage`, exit 2. If a real project reports an error, read it: either the rule is wrong (rule and fix it, ledger a ruling) or the project really has the problem (ledger it and tell the user; don't edit their reel.json).

- [ ] **Step 7: Checkpoint.**

---

### Task 3: Registry, queue and the server endpoints

**Files:** Create `bin/store.mjs`; modify `bin/selftest.mjs`, `player/serve.mjs`.

**Interfaces:**
- Produces (`store.mjs`): `home(): string`, `readPlayers(): Record<dir, {port, pid, started}>` (dead pids dropped and file rewritten), `addPlayer(dir, port): void`, `removePlayer(dir): void`, `queuePath(dir)`, `readQueue(dir): Batch[]`, `pushBatch(dir, payload): Batch`, `drainQueue(dir): Batch[]` (returns and clears); `Batch = {id, at, version, payload}`.
- Server: `POST /feedback` → `{ok: true, id, waiting}`; `GET /feedback` → `{waiting}`; `GET /poll` → `{batches}` (held up to 25 s; `{batches: []}` on timeout).

- [ ] **Step 1: Failing tests.** Append to `selftest()` (add `import {readPlayers, addPlayer, removePlayer, readQueue, pushBatch, drainQueue} from './store.mjs';`, `import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process'; import {fileURLToPath} from 'node:url';`):

```js
  // store: registry and queue, in a temp home and project
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motionos-test-')), proj = path.join(tmp, 'proj');
  process.env.MOTION_OS_HOME = path.join(tmp, 'home'); fs.mkdirSync(proj);
  addPlayer(proj, 5555); eq(Object.keys(readPlayers()), [proj], 'registry add');
  eq(readPlayers()[proj].pid, process.pid, 'registry pid is ours');
  const db = path.join(process.env.MOTION_OS_HOME, 'players.json'), reg = JSON.parse(fs.readFileSync(db, 'utf8'));
  reg['/gone'] = {port: 1, pid: 999999, started: 0}; fs.writeFileSync(db, JSON.stringify(reg));
  eq(Object.keys(readPlayers()), [proj], 'dead pids are dropped');
  removePlayer(proj); eq(readPlayers(), {}, 'registry remove');
  eq(readQueue(proj), [], 'empty queue');
  pushBatch(proj, {a: 1}); pushBatch(proj, {a: 2});
  eq(drainQueue(proj).map(b => b.payload.a), [1, 2], 'drain returns batches in order');
  eq(drainQueue(proj), [], 'drain clears');

  // server: /feedback and /poll, one batch to exactly one of two waiting polls
  fs.copyFileSync(fileURLToPath(new URL('../examples/qbot-tag/reel.json', import.meta.url)), path.join(proj, 'reel.json'));
  const srv = spawn(process.execPath, [fileURLToPath(new URL('../player/serve.mjs', import.meta.url)), proj, '--no-open', '--port', '4490'], {env: process.env, stdio: 'ignore'});
  try {
    for (let i = 0; i < 50 && !readPlayers()[proj]; i++) await new Promise(r => setTimeout(r, 100));
    const base = `http://localhost:${readPlayers()[proj].port}`;
    eq((await (await fetch(base + '/feedback')).json()).waiting, 0, 'nothing waiting');
    const p1 = fetch(base + '/poll').then(r => r.json()), p2 = fetch(base + '/poll').then(r => r.json());
    await new Promise(r => setTimeout(r, 200));
    const posted = await (await fetch(base + '/feedback', {method: 'POST', headers: {origin: base}, body: JSON.stringify({hello: 1})})).json();
    eq(posted.ok, true, 'feedback accepted');
    const first = await Promise.race([p1, p2]);
    eq(first.batches.map(b => b.payload.hello), [1], 'one poll gets the batch');
    eq((await (await fetch(base + '/feedback')).json()).waiting, 0, 'delivered batch left the queue');
    eq((await fetch(base + '/feedback', {method: 'POST', headers: {origin: 'https://evil.example'}, body: '{}'})).status, 403, 'other origins refused');
  } finally { srv.kill(); }
  await new Promise(r => setTimeout(r, 300));
  eq(readPlayers()[proj], undefined, 'server removes itself on exit');
```

(The second poll stays pending and is dropped with the server; Review Focus 2 is "never both".)

- [ ] **Step 2: Run, expect fail.** `$AXI --selftest` → `./store.mjs` not found.

- [ ] **Step 3: Implement** `bin/store.mjs`:

```js
// Where Motion OS keeps state: the player registry (~/.motion-os/players.json) and each project's feedback queue.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const home = () => process.env.MOTION_OS_HOME || path.join(os.homedir(), '.motion-os');
const regFile = () => path.join(home(), 'players.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), {recursive: true}); const t = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function readPlayers(){
  const all = readJson(regFile(), {}), live = Object.fromEntries(Object.entries(all).filter(([, p]) => alive(p.pid)));
  if (Object.keys(live).length !== Object.keys(all).length) writeJson(regFile(), live);
  return live;
}
export function addPlayer(dir, port){ const all = readPlayers(); all[dir] = {port, pid: process.pid, started: Date.now()}; writeJson(regFile(), all); }
export function removePlayer(dir){ const all = readJson(regFile(), {}); if (all[dir]?.pid === process.pid || !alive(all[dir]?.pid)) { delete all[dir]; writeJson(regFile(), all); } }

export const queuePath = dir => path.join(dir, '.motion-os', 'inbox.json');
export const readQueue = dir => readJson(queuePath(dir), []);
export function pushBatch(dir, payload){
  const q = readQueue(dir), b = {id: Date.now().toString(36) + q.length, at: new Date().toISOString(), version: payload?.version ?? null, payload};
  writeJson(queuePath(dir), [...q, b]); return b;
}
export function drainQueue(dir){ const q = readQueue(dir); if (q.length) writeJson(queuePath(dir), []); return q; }
```

(`removePlayer` only removes its own entry, or a dead one, so a newer server for the same project isn't unregistered by an old one exiting.)

- [ ] **Step 4: Server endpoints and registration** in `player/serve.mjs`:
- add `import {addPlayer, removePlayer, readQueue, pushBatch, drainQueue} from '../bin/store.mjs';`
- before `const server = http.createServer`, add:

```js
// Feedback from the player's Send, queued per project until `motion-os-axi poll` takes it. One waiting poll gets each batch.
const waiters = [];
function deliver(){
  while (waiters.length && readQueue(dir).length) {
    const res = waiters.shift();
    if (res.writableEnded || res.destroyed) continue;   // that poll already went away; keep the batch for the next one
    res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({batches: drainQueue(dir)}));
  }
}
const sameOrigin = req => !req.headers.origin || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req.headers.origin);
```

- inside the request handler, right after `const url = ...`:

```js
  if (url === '/feedback') {
    const send = (code, j) => res.writeHead(code, {'Content-Type': 'application/json'}).end(JSON.stringify(j));
    if (req.method !== 'POST') return send(200, {waiting: readQueue(dir).length});
    if (!sameOrigin(req)) return res.writeHead(403).end();
    let body = ''; req.on('data', c => body += c);
    return req.on('end', () => { try { const b = pushBatch(dir, JSON.parse(body || '{}')); send(200, {ok: true, id: b.id, waiting: readQueue(dir).length}); deliver(); } catch (e) { send(400, {ok: false, error: e.message}); } });
  }
  if (url === '/poll') {
    waiters.push(res);
    const t = setTimeout(() => { const i = waiters.indexOf(res); if (i >= 0) { waiters.splice(i, 1); res.writeHead(200, {'Content-Type': 'application/json'}).end('{"batches":[]}'); } }, 25000);
    res.on('close', () => { clearTimeout(t); const i = waiters.indexOf(res); if (i >= 0) waiters.splice(i, 1); });
    return deliver();
  }
```

- replace the `/export` origin test with `if (req.method === 'POST' && !sameOrigin(req)) return res.writeHead(403).end();`
- in `server.on('listening', ...)` add `addPlayer(dir, port);` as the first line, and after it register cleanup:

```js
const bye = () => { removePlayer(dir); process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye); process.on('exit', () => removePlayer(dir));
```

- [ ] **Step 5: Run, expect pass.** `$AXI --selftest` → `selftest ok`; `node player/serve.mjs --selftest` → `selftest ok`.

- [ ] **Step 6: Checkpoint.**

---

### Task 4: The rest of the CLI — status, open, poll, frame, export, stop, setup-hook, help

**Files:** Create `bin/format.mjs`; modify `bin/motion-os-axi.mjs`, `bin/selftest.mjs`.

**Interfaces:**
- Consumes: `store.mjs`, `check.mjs`, `toon.mjs`.
- Produces: `formatFeedback(batches, {full}): object` (TOON-ready); commands per the spec.

- [ ] **Step 1: Failing tests.** Append to `selftest()` (add `import {formatFeedback} from './format.mjs';`):

```js
  // format: batches -> poll output, merged in order
  const fb = (v, extra) => ({payload: {title: 'Demo', id: 'demo', version: v, edits: [], notes: [], trims: [], links: [], scenes: [{id: 'S1', name: 'Intro', status: 'review'}], ...extra}});
  const f1 = formatFeedback([fb(2, {edits: [{t: 1.5, scene: 'S1', element: 'Title', field: 'Text', from: 'Hi', to: 'Hello, world', src: 'src/A.tsx:3'}]}),
                             fb(2, {notes: [{n: 1, t: 3.2, scene: 'S1 Intro', x: 40, y: 50, on: 'Title', src: '', text: 'x'.repeat(130)}], links: ['https://a.example/f.png']})], {full: false});
  eq([f1.feedback, f1.counts], ['Demo v2 → set version 3', 'edits=1 notes=1 trims=0 links=1'], 'header and counts');
  eq(f1.edits[0].to, 'Hello, world', 'edit row');
  eq(f1.notes[0].text.endsWith('…(+10 chars)'), true, 'note text truncated');
  eq(formatFeedback([fb(2, {notes: [{n: 1, t: 1, text: 'x'.repeat(130)}]})], {full: true}).notes[0].text.length, 130, '--full');
  eq('trims' in f1, false, 'empty sections are left out');
```

- [ ] **Step 2: Run, expect fail.** `$AXI --selftest` → `./format.mjs` not found.

- [ ] **Step 3: Implement** `bin/format.mjs`:

```js
// Turns queued Send batches into the TOON-ready object `poll` prints. Times are render time (before trims), in seconds.
import {trunc} from './toon.mjs';

export function formatFeedback(batches, {full = false} = {}){
  const last = batches[batches.length - 1].payload, all = k => batches.flatMap(b => b.payload[k] || []);
  const edits = all('edits').map(e => ({...e, from: trunc(e.from, full), to: trunc(e.to, full)}));
  const notes = all('notes').map((n, i) => ({...n, n: i + 1, text: trunc(n.text, full)}));
  const trims = Object.values(Object.fromEntries(all('trims').map(t => [t.scene, t])));   // the latest trim per scene wins
  const links = [...new Set(all('links'))];
  const o = {feedback: `${last.title} v${last.version} → set version ${last.version + 1}`, clock: 'render time (before trims), seconds',
    counts: `edits=${edits.length} notes=${notes.length} trims=${trims.length} links=${links.length}`};
  if (edits.length) o.edits = edits;
  if (notes.length) o.notes = notes;
  if (trims.length) o.trims = trims;
  if (links.length) o.links = links;
  o.scenes = last.scenes || [];
  return o;
}
```

- [ ] **Step 4: Run, expect pass.** `$AXI --selftest` → `selftest ok`.

- [ ] **Step 5: Commands.** In `bin/motion-os-axi.mjs` add imports:

```js
import fs from 'node:fs';
import {spawn, exec, execFileSync} from 'node:child_process';
import {readPlayers, readQueue, drainQueue} from './store.mjs';
import {formatFeedback} from './format.mjs';
const SERVE = fileURLToPath(new URL('../player/serve.mjs', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const player = dir => { const p = readPlayers()[dir]; return p && {...p, url: `http://localhost:${p.port}`}; };
const openBrowser = url => exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} ${url}`);
```

Extend `COMMANDS` and add the command functions:

```js
const COMMANDS = {
  open:  {usage: 'open <project> [--no-open]', about: 'Start (or reuse) the player for a project and print its URL', flags: ['--no-open'], run: cmdOpen},
  check: {usage: 'check <project>', about: 'Validate reel.json: scene timing, ids, boxes, files, duration', flags: [], run: cmdCheck},
  poll:  {usage: 'poll <project> [--timeout <s>]', about: 'Wait for the user to press Send in the player; prints their edits, notes and trims', flags: ['--timeout'], run: cmdPoll},
  frame: {usage: 'frame <project> <t>', about: 'Save the frame at t seconds (render time) as a jpg', flags: [], run: cmdFrame},
  export:{usage: 'export <project> [--wait]', about: 'Status of the Export MP4 the user started in the player', flags: ['--wait'], run: cmdExport},
  stop:  {usage: 'stop [<project>]', about: 'Stop one player, or all of them', flags: [], run: cmdStop},
  'setup-hook': {usage: 'setup-hook', about: 'Print a Claude Code SessionStart hook that shows running players at session start', flags: [], run: cmdHook},
};

function cmdStatus(){
  const ps = Object.entries(readPlayers()).map(([dir, p]) => {
    let reel = {}; try { reel = JSON.parse(fs.readFileSync(path.join(dir, 'reel.json'), 'utf8')); } catch {}
    return {project: dir, url: `http://localhost:${p.port}`, version: reel.version ?? null, scenes: reel.scenes?.length ?? null, waiting: readQueue(dir).length};
  });
  out({bin: BIN, description: 'Motion OS: build a video in code, review it in a local player, get the user\'s feedback back with poll',
       ...(ps.length ? {players: ps} : {players: 'none running'})},
    ps.length ? [`Run \`${AXI} poll <project>\` to wait for the user's feedback`, `Run \`${AXI} check <project>\` after each re-render`]
              : [`Run \`${AXI} open <project>\` to open a project (a folder with reel.json) in the player`, `Run \`${AXI} --help\` for all commands`]);
}

async function cmdOpen(){
  const dir = projectDir(pos[1]);
  if (!fs.existsSync(path.join(dir, 'reel.json'))) fail('no_reel', `no reel.json in ${dir}`, ['Write reel.json first (see the motion-os skill, step 4)']);
  const errors = checkReel(dir).problems.filter(p => p.level === 'error').length;
  let p = player(dir), status = 'reused';
  if (!p) {
    fs.mkdirSync(path.join(dir, '.motion-os'), {recursive: true});
    const log = fs.openSync(path.join(dir, '.motion-os', 'server.log'), 'a');
    spawn(process.execPath, [SERVE, dir, '--no-open'], {detached: true, stdio: ['ignore', log, log]}).unref();
    for (let i = 0; i < 50 && !(p = player(dir)); i++) await sleep(100);
    if (!p) fail('start_failed', `the player didn't start; see ${path.join(dir, '.motion-os', 'server.log')}`);
    status = 'started';
  }
  if (!flags.has('--no-open')) openBrowser(p.url);
  let reel = {}; try { reel = JSON.parse(fs.readFileSync(path.join(dir, 'reel.json'), 'utf8')); } catch {}
  out({project: dir, url: p.url, version: reel.version ?? null, status, ...(errors ? {problems: `${errors} (run check)`} : {})},
    [`Tell the user: Preview plays it; Edit (E) to change things; N pins a note; K keyframes; drag a scene's end to trim; press Send when done`,
     `Run \`${AXI} poll ${dir}\` and keep it running until the user sends feedback`]);
}

async function cmdPoll(){
  const dir = projectDir(pos[1]), limit = Number(optVal('--timeout') || 0) * 1000, t0 = Date.now();
  const show = batches => out(formatFeedback(batches, {full}), [
    'Apply edits exactly, then work through the notes; leave scenes with status approved untouched',
    `Look at a note's spot first: \`${AXI} frame ${dir} <t>\``,
    'Download links into assets/ (ask first unless clearly the user\'s own file)',
    'Apply trims last; then re-render, run `' + AXI + ' check ' + dir + '`, and set reel.json "version" as shown in feedback']);
  for (;;) {
    const p = player(dir);
    if (!p) { const q = drainQueue(dir); if (q.length) return show(q); fail('no_player', `no player running for ${dir}`, [`Run \`${AXI} open ${dir}\``]); }
    const left = limit ? limit - (Date.now() - t0) : 25000;
    if (limit && left <= 0) return out({feedback: 'none yet'}, [`Run \`${AXI} poll ${dir}\` again to keep waiting`]);
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), Math.min(left, 26000));
      const j = await fetch(p.url + '/poll', {signal: ctl.signal}).then(r => r.json()); clearTimeout(timer);
      if (j.batches?.length) return show(j.batches);
    } catch (e) { if (e.name !== 'AbortError') await sleep(500); }
  }
}

function cmdFrame(){
  const dir = projectDir(pos[1]), t = Number(pos[2]);
  if (!pos[2] || isNaN(t)) usage('frame needs <project> <t> (seconds)');
  let reel; try { reel = JSON.parse(fs.readFileSync(path.join(dir, 'reel.json'), 'utf8')); } catch { fail('no_reel', `no readable reel.json in ${dir}`); }
  const file = path.join(dir, '.motion-os', 'frames', `${t.toFixed(2)}.jpg`); fs.mkdirSync(path.dirname(file), {recursive: true});
  try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', path.join(dir, reel.src), '-frames:v', '1', file], {stdio: ['ignore', 'ignore', 'pipe']}); }
  catch (e) { fail(e.code === 'ENOENT' ? 'no_ffmpeg' : 'ffmpeg_failed', e.code === 'ENOENT' ? 'ffmpeg is not installed' : String(e.stderr || e.message).trim()); }
  out({frame: file, t}, ['Read the image to see what the note points at']);
}

async function cmdExport(){
  const dir = projectDir(pos[1]), p = player(dir);
  if (!p) fail('no_player', `no player running for ${dir}`, [`Run \`${AXI} open ${dir}\``]);
  let j = await fetch(p.url + '/export').then(r => r.json());
  while (flags.has('--wait') && j.state === 'running') { await sleep(2000); j = await fetch(p.url + '/export').then(r => r.json()); }
  out({state: j.state, pct: j.pct ?? null, out: j.out ? path.join(dir, j.out) : null, line: j.line ?? null},
    j.state === 'idle' ? ['Ask the user to press Export MP4 in the player (live projects only)'] : j.state === 'running' ? [`Run \`${AXI} export ${dir} --wait\` to wait for it`] : []);
}

function cmdStop(){
  const all = readPlayers(), dirs = pos[1] ? [projectDir(pos[1])].filter(d => all[d]) : Object.keys(all);
  if (!dirs.length) return out({players: 'none running'});
  for (const d of dirs) try { process.kill(all[d].pid, 'SIGTERM'); } catch {}
  out({stopped: dirs}, [`Run \`${AXI} open <project>\` to start one again`]);
}

function cmdHook(){
  const hook = {hooks: {SessionStart: [{hooks: [{type: 'command', command: `node ${BIN}`}]}]}};
  out({paste_into: '~/.claude/settings.json (merge into "hooks")', snippet: JSON.stringify(hook)}, ['This prints only; nothing was changed']);
}
```

Replace the dispatch block at the end so no arguments shows status and `--help` lists commands:

```js
if (argv[0] === '--selftest') { /* unchanged */ }
if (!pos.length && flags.has('--help')) {
  out({usage: `${AXI} <command> [args] [flags]`, commands: Object.values(COMMANDS).map(c => ({usage: c.usage, about: c.about})), flags: ['--help', '--full']},
    [`Run \`${AXI}\` with no arguments for running players`]);
  process.exit(0);
}
if (!pos.length) { for (const f of flags) usage(`unknown flag ${f}`); cmdStatus(); process.exit(0); }
const cmd = COMMANDS[pos[0]];
if (!cmd) usage(`unknown command "${pos[0]}"`);
const known = new Set(['--help', '--full', ...cmd.flags]);
for (const f of flags) if (!known.has(f)) usage(`unknown flag ${f} for ${pos[0]}`);
if (flags.has('--help')) { out({usage: `${AXI} ${cmd.usage}`, about: cmd.about, flags: [...cmd.flags, '--full']}); process.exit(0); }
await cmd.run();
process.exit(0);
```

(`--timeout` takes a value; `pos` would pick up that value as a positional. Exclude it: build `pos` from `argv` skipping the item after `--timeout`.) Change the `pos` line to:

```js
const pos = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--timeout');
```

- [ ] **Step 6: CLI walkthrough on qbot-tag** (temp registry from the helpers):

```bash
$AXI; echo "exit $?"                                   # players: none running, help[]
$AXI --help | head -12
$AXI open examples/qbot-tag --no-open                    # status: started, url
$AXI open examples/qbot-tag --no-open                    # status: reused, same url
$AXI                                                     # players[1] row with version, scenes 8, waiting 0
$AXI poll examples/qbot-tag --timeout 2                  # feedback: none yet
$AXI frame examples/qbot-tag 3.2; ls -l examples/qbot-tag/.motion-os/frames/
$AXI export examples/qbot-tag                            # state: idle + help
$AXI stop examples/qbot-tag; $AXI                        # stopped[1], then none running
$AXI poll examples/qbot-tag --timeout 1; echo "exit $?"  # error: no_player, exit 1
$AXI frobnicate; echo "exit $?"                          # error: usage, exit 2
$AXI setup-hook
```

Stale registry (Review Focus 3): `$AXI open examples/qbot-tag --no-open`, then `kill -9 <pid from registry>`, then `$AXI` → `players: none running`, and `$AXI open ... --no-open` → `status: started`. Stop it after.

Add `examples/qbot-tag/.motion-os/` to the repo's `.gitignore` (create the file with `.motion-os/`).

- [ ] **Step 7: Checkpoint.**

---

### Task 5: Player — structured Send

**Files:** Modify `player/index.html`: replace `describe()` and `prompt()` (lines ~895-928) with `editRow()` and `feedback()`; replace the `#sendBtn` handler (~931-941); add a waiting badge to the top bar and to the 3 s reel poll (~1105); update `selftest()` checks that used `describe`/`prompt` (~1022-1023, ~1068-1070); Send button tooltip.

**Interfaces:**
- Produces: `editRow(path, v): {t, scene, element, field, from, to, src}`, `feedback(): {title, id, version, path, fps, duration, edits, notes, trims, links, scenes}` (the payload `format.mjs` reads; `t` in render-time seconds).

- [ ] **Step 1: Failing tests.** In `selftest()`:
- replace the two `describe(...)` lines with:

```js
    const kr = editRow(`${id}.@keys`, elKeys(e));
    eq([kr.field, kr.to.startsWith(`${+fps1(T0).toFixed(2)}s [${e.box.join(' ')}] -> `), kr.to.endsWith('(ease in-out)')], ['keyframes', true, true], 'feedback keyframes row');
```

- replace the `const pr = prompt(); ...` three lines with:

```js
    const fbk = feedback();
    eq(fbk.trims, [{scene: s0.id, name: s0.name, from: +O0.toFixed(2), to: +L0.toFixed(2), drop: `${(s0.t[0] + L0).toFixed(2)}-${s0.t[1].toFixed(2)}s`, shift: `-${(O0 - L0).toFixed(2)}s`}], 'feedback has the trim');
    eq(fbk.edits.length, 0, 'trims are not edits');
```

- add, before `} finally`, the Send-failure check (Review Focus 5):

```js
    // Send with the server unreachable marks nothing as sent
    st.over = {[`${s0.id}.@len`]: L0}; st.sentSnap = {}; const realFetch = window.fetch; window.fetch = () => Promise.reject(new Error('offline'));
    try { await sendFeedback(); } finally { window.fetch = realFetch; }
    eq(pendingEdits(), 1, 'failed send keeps edits pending');
```

and make `selftest` `async` (`async function selftest(){`); callers already wrap it, and the browser checks below `await` it.

- [ ] **Step 2: Run, expect fail.** Reload `localhost:4321`: `E "(async () => { try { return await selftest(); } catch (e) { return 'FAIL ' + e.message; } })()"` → `FAIL editRow is not defined`.

- [ ] **Step 3: Implement.** Replace `function describe(path, v){...}` and `function prompt(){...}` with:

```js
/* ================= send to Claude: structured feedback the agent receives with `motion-os-axi poll` ================= */
const boxStr = b => `[${b.join(' ')}]`;
function editRow(path, v){
  const show = x => Array.isArray(x) ? x.map(r => Object.values(r).join(' | ')).join(' / ') : typeof x === 'string' && x.includes('/') ? assetName(x) : typeof x === 'string' ? x : JSON.stringify(x);
  const style = path.startsWith('brand.color.') ? ['Style', `${P.brand.colors.find(c => c.id === path.slice(12)).name} color (used everywhere)`]
    : path.startsWith('brand.font.') ? ['Style', `${P.brand.fonts.find(f => f.id === path.slice(11)).name} font`] : path === 'brand.logo' ? ['Style', 'Logo']
    : path === 'audio.music' ? ['Audio', 'Music track'] : path === 'audio.musicVol' ? ['Audio', 'Music volume'] : path === 'audio.sfxVol' ? ['Audio', 'Effects volume'] : null;
  if (style) return {t: null, scene: '', element: style[0], field: style[1], from: show(baseOf(path)), to: show(v), src: ''};
  const [id, k] = path.split('.'), e = elById(id), row = {t: +elTime(e)[0].toFixed(2), scene: e.s, element: e.label, src: e.src || ''};
  if (k === '@keys') return v.length === 1 ? {...row, t: v[0].t, field: 'size+position', from: boxStr(e.box), to: boxStr(v[0].box)}
    : {...row, t: v[0].t, field: 'keyframes', from: boxStr(e.box), to: v.map(x => `${+x.t.toFixed(2)}s ${boxStr(x.box)}`).join(' -> ') + ' (ease in-out)'};
  if (k === '@box') return {...row, field: 'size+position', from: boxStr(e.box), to: `${boxStr(v)} scale ${Math.round(v[2] / e.box[2] * 100)}%`};
  if (k === '@time') return {...row, field: 'timing (s)', from: e.t.join('-'), to: v.join('-')};
  return {...row, field: k === 'motion' || e.props[k].type === 'motion' ? 'motion' : e.props[k].label, from: show(baseOf(path)), to: show(v)};
}
function feedback(){
  const fresh = ([k, v]) => JSON.stringify(st.sentSnap[k]) !== JSON.stringify(v), over = Object.entries(st.over).filter(fresh);
  return {title: P.title, id: P.id, version: P.version || 1, path: P.path || '', fps: P.fps, duration: P.duration,
    edits: over.filter(([k]) => !k.endsWith('.@len')).map(([k, v]) => editRow(k, v)),
    notes: openNotes().map((n, i) => { const e = n.el && elById(n.el), s = sceneAt(n.t); return {n: i + 1, t: n.t, scene: `${s.id} ${s.name}`, x: n.x, y: n.y, on: e ? e.label : '', src: e?.src || '', text: n.text}; }),
    trims: over.filter(([k]) => k.endsWith('.@len')).map(([k]) => { const s = sceneOf(k.split('.')[0]), O = s.t[1] - s.t[0], L = sceneLen(s);
      return {scene: s.id, name: s.name, from: +O.toFixed(2), to: +L.toFixed(2), drop: `${(s.t[0] + L).toFixed(2)}-${s.t[1].toFixed(2)}s`, shift: `-${(O - L).toFixed(2)}s`}; }),
    links: st.links.filter(l => !l.sent).map(l => l.url),
    scenes: P.scenes.map(s => ({id: s.id, name: s.name, status: st.status[s.id]}))};
}
async function sendFeedback(){
  if (!(pendingEdits() + openNotes().length)) return toast('Nothing to send yet. Edit something, or press N to pin a note.');
  try {
    const r = await fetch('feedback', {method: 'POST', body: JSON.stringify(feedback())});
    if (!r.ok) throw new Error(`the player server answered ${r.status}`);
    st.sent = [...new Set([...st.sent, ...openNotes().map(n => n.id)])]; st.sentSnap = JSON.parse(JSON.stringify(st.over)); st.links.forEach(l => l.sent = true);
    renderAll(); toast('Sent to Claude'); checkWaiting();
  } catch (e) { toast(`Couldn't send: ${e.message}. Is the player still running?`); }
}
```

(Motion props: check how motion props are keyed. In the existing code the `motion` edits are paths ending `.motion`; the `field` test above covers both a key named `motion` and a prop of type `motion`.)

Replace the `#sendBtn` handler with `$('#sendBtn').onclick = sendFeedback;`. Change the Send button's `data-tip` to `"Sends every edit, note and trim to Claude. Claude picks it up with motion-os-axi poll."`. Keep `sheet()` (Export and the asset picker use it).

- [ ] **Step 4: Waiting badge.** In the top bar, before `#exportBtn`, add `<span class="saved" id="waitBadge" hidden><i style="background:var(--accent)"></i><span>Waiting for Claude</span></span>`. Add:

```js
function checkWaiting(){ fetch('feedback').then(r => r.json()).then(j => { $('#waitBadge').hidden = !j.waiting; $('#waitBadge span').textContent = j.waiting > 1 ? `Waiting for Claude (${j.waiting})` : 'Waiting for Claude'; }).catch(() => {}); }
```

and call `checkWaiting()` inside the existing 3 s `setInterval` (first line of its callback) and once after `loadProject()`.

- [ ] **Step 5: Run, expect pass.** Reload 4321 and 4400 (start qbot with `$AXI open examples/qbot-tag --no-open`): `E "(async () => { try { return await selftest(); } catch (e) { return 'FAIL ' + e.message; } })()"` → `selftest ok` on both. `grep -c "function prompt\|function describe\|doCopy" player/index.html` → `0`.

- [ ] **Step 6: End to end on qbot-tag.**

```bash
$AXI poll examples/qbot-tag --timeout 60 > $MOTION_OS_HOME/poll.out &   # run as a tracked background job
E "(() => { localStorage.clear(); location.reload(); return 1; })()"; sleep 3
E "(() => { const e = allEls().find(x => Object.values(x.props).some(p => p.type === 'text')); const k = Object.keys(e.props).find(k => e.props[k].type === 'text');
  set(e.id + '.' + k, 'Changed, with a comma', e.props[k].v); st.notes.push({id: 99, t: 3.2, x: 40, y: 50, el: null, text: 'Slow this down: it feels rushed'});
  set(P.scenes[0].id + '.@len', fps1(P.scenes[0].t[1] - P.scenes[0].t[0] - 1), P.scenes[0].t[1] - P.scenes[0].t[0]); renderAll(); return 1; })()"
E "(async () => { await sendFeedback(); return document.querySelector('.toast')?.textContent; })()"   # Sent to Claude
wait; cat $MOTION_OS_HOME/poll.out
$AXI poll examples/qbot-tag --timeout 2                                  # feedback: none yet
E "(() => { checkWaiting(); return 1; })()"; sleep 1; E "document.querySelector('#waitBadge').hidden"   # true
```

Expected `poll.out`: `feedback: Qbot x Claude Tag v5 → set version 6`, `counts: edits=1 notes=1 trims=1 links=0`, the edit row with `"Changed, with a comma"` quoted as one cell, the note with `t` 3.2 and its text, the trim row for S1, `scenes[8]`, `help[4]`. Also send once with no poll running and confirm the badge shows "Waiting for Claude" and `$AXI` shows `waiting: 1`; then `$AXI poll examples/qbot-tag` returns it at once.

Clean up: `E "(() => { localStorage.clear(); return 1; })()"`, `$AXI stop`.

- [ ] **Step 7: Checkpoint.**

---

### Task 6: SKILL.md and Herdcats check

**Files:** Modify `SKILL.md`.

- [ ] **Step 1: Top-of-file AXI note.** After the first paragraph under `# Motion OS`, add:

```markdown
Drive it with the `motion-os-axi` CLI (an [AXI](https://axi.md)): `node "$SKILL_DIR/bin/motion-os-axi.mjs"`. Run it with no arguments for running players; every command ends with next steps, and `--help` works everywhere. It needs only Node 18+ (ffmpeg for `frame`).
```

- [ ] **Step 2: Step 3 (render and check):** after the contact-sheet paragraph add: ``Then run `motion-os-axi check <project>` and fix any errors before showing it.``

- [ ] **Step 3: Step 5:** replace the `serve.mjs` code block and its following paragraph with:

```markdown
```bash
node "$SKILL_DIR/bin/motion-os-axi.mjs" open "<project>"
```

It starts the player (or reuses the one already serving this project), opens the browser and prints the URL. Motion OS keeps its queue, frames and log in `<project>/.motion-os/`; add that to the project's `.gitignore`.
```

and in the "Then tell the user" paragraph replace `and when they're done, click **Send to Claude**, copy the prompt and paste it here.` with `and when they're done, click **Send to Claude**.`

- [ ] **Step 4: Step 6:** replace the heading paragraph `When the user pastes a prompt starting with "Motion OS feedback for":` with:

```markdown
Run `motion-os-axi poll <project>` and leave it running until it returns (in the foreground, or as a background job your harness tracks and wakes you for; if it's interrupted, run it again, feedback stays queued). It prints the user's edits, notes, trims, links and scene statuses as rows; times are render time in seconds. Then:
```

and change the Notes bullet's frame command to `` `motion-os-axi frame <project> <t>` `` (instead of the raw ffmpeg line). Update the skill's frontmatter `description`: replace `or pastes feedback that starts with "Motion OS feedback for"` with `or wants feedback from an open Motion OS player`.

- [ ] **Step 5: Read back** `git diff SKILL.md`.

- [ ] **Step 6: Herdcats, real registry.** `unset MOTION_OS_HOME`. The Herdcats player on 4321 was started by the old `serve.mjs` (not registered): stop it (`kill` its pid from `lsof -ti :4321`), then `$AXI open /Users/zhiyaochan/Projects/ios-app/herdcats-launch-video --no-open` → `status: started` (port 4321 or next). Run its player `selftest()` → `selftest ok`. Add keyframes to the tagline (`addKey` as before), `sendFeedback()`, and `$AXI poll <herdcats>` shows a `keyframes` row. Leave this player running for the user, with storage cleared.

- [ ] **Step 7: Full check run:** `$AXI --selftest`, `node player/serve.mjs --selftest`, `$AXI check examples/qbot-tag`, `$AXI check <herdcats>` — all clean.

- [ ] **Step 8: Checkpoint.** Ask the user before committing.
