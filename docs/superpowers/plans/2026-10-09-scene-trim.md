# Scene Trim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user shorten a scene by dragging its end on the Motion OS AXI timeline; later scenes ripple earlier, playback and Export show the trimmed edit, and Claude gets the trims in the prompt.

**Architecture:** All stored times stay in render time (the current video's clock). A trim is one override per scene (`<sid>.@len`). Two pure mappings, `toEd` (render → edited) and `toSrc` (edited → render), convert at the edges: the timeline, the timecode and time fields show edited time; mp4 playback jumps over cut tails; the live renderer gets `scenes` lengths and its clock is converted back to render time in the `liveVideo` wrapper.

**Tech Stack:** Plain HTML/JS player (one `index.html`, no build); Remotion 4 + React 18 + esbuild for the Herdcats live renderer; ffmpeg/ffprobe; `chrome-devtools-axi` for browser checks.

**Spec:** `docs/specs/2026-10-09-scene-trim-design.md`

## Global Constraints

- Cut, not speed up. Shorten only: new length between 0.5s and the original length (`s.t[1] - s.t[0]`), rounded to 1/fps.
- Only a scene's end moves. No start trims, no reordering.
- Stored times (element `t`, `@time`, notes `t`, keyframe `t`, scene `t`) stay in render time; trims never rewrite them.
- Times the user reads are edited time; the prompt's times are render time, with the header "Times are in the current render (before trims)."
- Live bundles without `setScenes` get no trim handle.
- No new dependencies in the player.
- Commits: the user is holding commits. Checkpoints only; `git commit` only once the user says so. Herdcats is not a git repo: Task 4 backs it up first.

## Review Focus

1. The playhead sits inside the part being cut when the trim is made: it must move to the scene's new end, never show a cut frame. (Task 2 Step 1: `seek` into a cut lands on the new end; Task 2 Step 7 re-seeks after a drag.)
2. Keyframes on a scene after a trimmed one (live): they must stay on their content, i.e. `Ed` keeps using the scene's original start. (Task 5 Step 5 frame check.)
3. Typing an element's timing (or a keyframe time) after a trim: the field shows edited time and stores render time. (Task 2 Step 1 timing-field test.)
4. Loop-scene on a trimmed scene: it must loop at the new end, not the old one. (Task 2 Step 1 `sceneEnd` test.)
5. Trim sent, then Claude's new version loads: the sent trim is dropped (its value matched what was sent), so it isn't applied twice. (Task 3 Step 1 `keepAfterNewVersion` assertion.)

---

## File Structure

- `player/index.html` (modify): clocks (`sceneLen`, `edDur`, `toEd`, `toSrc`, `isCut`, `sceneEnd`, `nextAfterCut`), timeline in edited time, trim drag, seek/playback, displayed times, scene panel length row, prompt Trims section, live `setScenes` sync, export body, `selftest()` cases.
- `SKILL.md` (modify): live `scenes` prop and `setScenes`; how to apply trims.
- Herdcats `/Users/zhiyaochan/Projects/ios-app/herdcats-launch-video/`:
  - `src/trim.ts` (create): pure `sceneLen(id, lens)`, `totalLen(lens)`, `Lens` type (imports only `reel.json`, so node can run its check).
  - `src/trim.check.ts` (create): assertions.
  - `src/Main.tsx`, `src/index.ts`, `src/live.tsx` (modify); `reel.json` `export.props` (modify); `motion-os-axi-live.js` (rebuild).

Browser helpers used below:

```bash
export CHROME_DEVTOOLS_AXI_SESSION=motionos
E() { chrome-devtools-axi eval "$1" | head -1; }
T() { E "(() => { try { return selftest(); } catch (e) { return 'FAIL ' + e.message; } })()"; }
S=/private/tmp/claude-501/-Users-zhiyaochan-Projects-ios-app-herdcats/ea6b1804-48f6-461b-b532-1b5534a92163/scratchpad
```

Herdcats player: `http://localhost:4321` (already running). qbot-tag (mp4-only): start with `node player/serve.mjs examples/qbot-tag --no-open --port 4400` in the background from the fork, stop it after. `chrome-devtools-axi screenshot` prints an error but saves the file; use a fresh filename each time.

---

### Task 1: The two clocks

**Files:**
- Modify: `player/index.html` — after `const now = () => vid.currentTime;` (line ~406); `selftest()` (end of its `try` block, before `} finally`).

**Interfaces:**
- Produces: `sceneLen(s): number` (edited length, clamped to original), `sceneLayout(): {s, S, L, E}[]`, `edDur(): number`, `toEd(t): number`, `toSrc(t): number`, `isCut(t): boolean`, `sceneEnd(s): number` (render time of the scene's new end), `nextAfterCut(t): number | null | -1` (render time to jump to; `null` = not in a cut; `-1` = cut tail of the last scene, stop).

- [ ] **Step 1: Write the failing test.** Append inside `selftest()`'s `try`, before `} finally`:

```js
    // two clocks: render time (stored) vs edited time (what you watch with cut tails removed)
    const r3 = x => Math.round(x * 1000) / 1000, [s0, s1, s2] = P.scenes, O0 = s0.t[1] - s0.t[0], L0 = fps1(O0 - 1), f = 1 / P.fps;
    st.over = {};
    eq([r3(toEd(1.234)), r3(toSrc(1.234)), r3(edDur())], [1.234, 1.234, r3(P.duration)], 'no trims is identity');
    st.over[`${s0.id}.@len`] = L0;
    eq(r3(sceneLen(s0)), r3(L0), 'trimmed length');
    eq(r3(toEd(s0.t[0] + 0.2)), r3(s0.t[0] + 0.2), 'before the cut unchanged');
    eq([isCut(s0.t[0] + L0 + 0.5), isCut(s0.t[0] + L0 - 0.1)], [true, false], 'cut tail detected');
    eq(r3(toEd(s0.t[0] + L0 + 0.5)), r3(L0), 'cut tail maps to the new end');
    eq(r3(toEd(s1.t[0] + 0.3)), r3(L0 + 0.3), 'later scene moves earlier');
    eq(r3(toSrc(L0 + 0.3)), r3(s1.t[0] + 0.3), 'edited back to render');
    eq(r3(toSrc(L0 - 0.1)), r3(s0.t[0] + L0 - 0.1), 'edited inside trimmed scene');
    eq(r3(sceneEnd(s0)), r3(s0.t[0] + L0), 'scene end is the new end');
    eq([r3(nextAfterCut(s0.t[0] + L0 + f)), nextAfterCut(s0.t[0] + 0.1)], [r3(s1.t[0]), null], 'jump target after a cut');
    st.over[`${s1.id}.@len`] = fps1(s1.t[1] - s1.t[0] - 0.5);
    eq(r3(edDur()), r3(P.duration - (O0 - L0) - (s1.t[1] - s1.t[0] - sceneLen(s1))), 'two trims shorten the total');
    if (s2) eq(r3(toEd(s2.t[0])), r3(L0 + sceneLen(s1)), 'two trims stack');
    eq(r3(toSrc(edDur())), r3(P.duration), 'end maps to end');
    st.over[`${s0.id}.@len`] = O0 + 5; eq(r3(sceneLen(s0)), r3(O0), 'length never exceeds the original');
    const last = P.scenes[P.scenes.length - 1]; st.over = {[`${last.id}.@len`]: fps1(last.t[1] - last.t[0] - 0.5)};
    eq(nextAfterCut(P.duration - 0.1), -1, 'last scene cut tail stops');
```

- [ ] **Step 2: Run to verify it fails.** Reload `localhost:4321`, `T` → `FAIL toEd is not defined`.

- [ ] **Step 3: Implement.** After `const now = () => vid.currentTime;` add:

```js
/* trims: "<sid>.@len" shortens a scene by cutting its tail; later scenes move earlier. Stored times stay in render time
   (the current video's clock); edited time is what you watch with cut tails removed. */
const sceneLen = s => Math.min(get(`${s.id}.@len`, s.t[1] - s.t[0]), s.t[1] - s.t[0]);
function sceneLayout(){ let E = 0; return P.scenes.map(s => { const o = {s, S:s.t[0], L:sceneLen(s), E}; E += o.L; return o; }); }
const edDur = () => P.scenes.reduce((n, s) => n + sceneLen(s), 0);
const sceneEnd = s => s.t[0] + sceneLen(s);
const isCut = t => { const s = sceneAt(t); return t > sceneEnd(s) + 1e-6; };
function toEd(t){ const s = sceneAt(t), o = sceneLayout().find(o => o.s === s); return o.E + clamp(t - o.S, 0, o.L); }
function toSrc(t){ const ls = sceneLayout(), o = ls.find(o => t < o.E + o.L) || ls[ls.length - 1]; return o.S + clamp(t - o.E, 0, o.L); }
// Where playback goes from render time t: null if t isn't in a cut tail, the next scene's start, or -1 after the last scene.
function nextAfterCut(t){ if (!isCut(t)) return null; const i = P.scenes.indexOf(sceneAt(t)); return i < P.scenes.length - 1 ? P.scenes[i + 1].t[0] : -1; }
```

- [ ] **Step 4: Run to verify it passes.** Reload, `T` → `selftest ok`. Also on qbot-tag (`localhost:4400`) → `selftest ok`.

- [ ] **Step 5: Checkpoint.** `git diff --stat` shows only `player/index.html`. Commit only if okayed.

---

### Task 2: Timeline in edited time, trim drag, seek and playback

**Files:**
- Modify: `player/index.html` — CSS (after `.sb.on{...}`); `seek` (~421); `vframe` (~429); `tick` (~468); `pct`/`renderTL`/`placePH`/`scrubTo`/`#tl` pointer handlers (~596-620); `scenePane` (~634); `notesPane` (~743); `renderPop` meta (~577); `scriptPane` timestamps (~704-705); `keysHTML` Time value and its `change` handler (~810); `timingHTML` values and `d.time` input handler (~793); `keyNow` toast; keyframe diamond tip; `TIPS`.

**Interfaces:**
- Consumes: Task 1's functions.
- Produces: `epct(edT): string`, `pct(srcT): string` (now edited-time based), `canTrim(): boolean`, module-level `trimming: {sid, E, O, D0} | null`, `tlDur(): number`.

- [ ] **Step 1: Write the failing tests.** Append inside `selftest()`'s `try`, before `} finally`:

```js
    // seek, loop end and time fields respect trims
    st.over = {[`${s0.id}.@len`]: L0};
    seek(s0.t[0] + L0 + 0.5); eq(r3(now()), r3(s0.t[0] + L0 - f), 'seek into a cut lands on the new end');
    eq(loopEnd(s0), sceneEnd(s0), 'loop uses the new end');
    const e1 = allEls().find(x => x.s === s1.id); Object.assign(ui, {sel:e1.id, scene:s1.id, tab:'scene'}); renderPane();
    const tf = document.querySelector(`[data-time="${e1.id}"][data-ix="0"]`);
    eq(+tf.value, Math.round(toEd(e1.t[0]) * 10) / 10, 'timing field shows edited time');
    tf.value = String(Math.round((toEd(e1.t[0]) + 0.2) * 10) / 10); tf.dispatchEvent(new Event('input', {bubbles:true}));
    eq(elTime(e1)[0], Math.round((e1.t[0] + 0.2) * 10) / 10, 'timing field stores render time');
```

- [ ] **Step 2: Run to verify it fails.** Reload, `T` → `FAIL seek into a cut lands on the new end: ...` (seek doesn't clamp yet).

- [ ] **Step 3: Seek, loop, playback skip, timecode.**

Replace the first two lines of `seek`:

```js
function seek(t){
  t = clamp(t, 0, P.duration - 0.02);
  if (isCut(t)) t = sceneEnd(sceneAt(t)) - 1 / P.fps;
  vid.currentTime = t;
```

Replace `vframe` with:

```js
const loopEnd = s => sceneEnd(s);
function vframe(){ if (!vid.paused) {
  if (ui.loop) { const s = sceneOf(ui.scene); if (vid.currentTime >= loopEnd(s) - 0.03) vid.currentTime = s.t[0]; }
  else if (!live) { const j = nextAfterCut(vid.currentTime); if (j === -1) { vid.currentTime = sceneEnd(sceneAt(vid.currentTime)) - 1 / P.fps; pause(); } else if (j != null) vid.currentTime = j; }
  tick(); requestAnimationFrame(vframe); } }
```

In `tick`, replace the `$('#tc').innerHTML = ...` line with:

```js
  $('#tc').innerHTML = `${fmt(toEd(t))} <small>/ ${fmt(edDur())} · ${s.id} ${esc(s.name)}</small>`;
```

- [ ] **Step 4: Displayed times and time inputs in edited time.**

- `timingHTML`: values `value="${v[0]}"` and `value="${v[1]}"` become `value="${Math.round(toEd(v[0]) * 10) / 10}"` and `value="${Math.round(toEd(v[1]) * 10) / 10}"`.
- `d.time` input handler: `v[+d.ix] = Math.round(Number(t.value) * 10) / 10;` becomes `v[+d.ix] = Math.round(toSrc(Number(t.value)) * 10) / 10;`
- `keysHTML` Time field: `+k.t.toFixed(2)` (the Time value) becomes `+toEd(k.t).toFixed(2)`.
- keyframe time `change` handler: `keys[+d.i].t = fps1(clamp(v, 0, P.duration));` becomes `keys[+d.i].t = fps1(toSrc(clamp(v, 0, edDur())));`
- keyframe diamond tip `keyframe at ${fmt(k.t)}` → `keyframe at ${fmt(toEd(k.t))}`; `keyNow` toast `fmt(fps1(now()))` → `fmt(toEd(now()))`.
- `renderPop` meta `${fmt(p.t)}` → `${fmt(toEd(p.t))}`.
- `notesPane`: `${fmt(n.t)}</button>` → `${fmt(toEd(n.t))}</button>${isCut(n.t) ? '<span class="tag">Cut</span>' : ''}`.
- `scriptPane`: both `${fmt(elTime(it.e)[0])}` → `${fmt(toEd(elTime(it.e)[0]))}`.

- [ ] **Step 5: Run the tests.** Reload, `T` → `selftest ok`.

- [ ] **Step 6: Timeline layout and trim drag.** CSS after `.sb.on{...}`:

```css
.trim{position:absolute;right:-1px;top:-1px;bottom:-1px;width:8px;cursor:ew-resize;border-radius:0 7px 7px 0}
.trim:hover,.sb.trimming .trim{background:var(--accent);opacity:.55}
.sb .cut{color:var(--accent);font-weight:600}
```

Replace `const pct = t => (t / P.duration * 100) + '%';` with:

```js
let trimming = null;  // {sid, E, O, D0} while dragging a scene's end; the scale is frozen at D0 so the pointer doesn't chase it
const tlDur = () => trimming ? trimming.D0 : edDur();
const epct = t => (t / tlDur() * 100) + '%';   // edited time -> % of the timeline
const pct = t => epct(toEd(t));                 // render time -> % of the timeline
const canTrim = () => !live || !!live.setScenes;
```

In `renderTL`:
- beats loop: `t < P.duration` → `t < edDur()`, and `style="left:${pct(t)}"` → `style="left:${epct(t)}"`.
- keyframe line width `width:${pct(keys[1].t - keys[0].t)}` → `width:${epct(toEd(keys[1].t) - toEd(keys[0].t))}`; each diamond adds `${isCut(k.t) ? 'opacity:.35;' : ''}` to its style.
- note pins: style `${st.sent.includes(n.id) ? 'opacity:.35' : ''}` → `${st.sent.includes(n.id) || isCut(n.t) ? 'opacity:.35' : ''}`.
- scene blocks: replace the `<div class="trk scenes">...</div>` line with:

```js
    <div class="trk scenes">${sceneLayout().map(({s, L, E}) => `<div class="sb ${ui.scene === s.id ? 'on' : ''} ${trimming?.sid === s.id ? 'trimming' : ''}" data-scene="${s.id}" style="left:${epct(E)};width:calc(${epct(L)} - 3px)" ${canTrim() ? '' : 'data-tip="Trimming needs an updated live renderer"'}><b>${esc(s.name)}</b><small><span class="sd ${st.status[s.id]}"></span>${L < s.t[1] - s.t[0] - 1e-6 ? `<span class="cut">${L.toFixed(1)}s</span>` : `${L.toFixed(1)}s`}</small>${canTrim() ? `<i class="trim" data-trim="${s.id}" data-tip="Drag left to shorten this scene"></i>` : ''}</div>`).join('')}</div>
```

`scrubTo`: `seek((ev.clientX - r.left) / r.width * P.duration)` → `seek(toSrc((ev.clientX - r.left) / r.width * edDur()))`.

`#tl` pointerdown, first line:

```js
  const tr = ev.target.closest('[data-trim]'); if (tr) { const s = sceneOf(tr.dataset.trim), o = sceneLayout().find(o => o.s === s); pause(); trimming = {sid:s.id, E:o.E, O:s.t[1] - s.t[0], D0:edDur()}; ev.preventDefault(); return; }
```

Window `pointermove` becomes:

```js
window.addEventListener('pointermove', ev => {
  if (trimming) { const r = $('#tl .trk').getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * trimming.D0, s = sceneOf(trimming.sid);
    set(`${s.id}.@len`, fps1(clamp(x - trimming.E, Math.min(0.5, trimming.O), trimming.O)), trimming.O); renderTL(); return; }
  if (scrubbing) scrubTo(ev);
});
```

Window `pointerup` becomes:

```js
window.addEventListener('pointerup', () => { scrubbing = false;
  if (trimming) { const sid = trimming.sid; trimming = null; touchScene(sid); seek(now()); renderAll(); } });
```

(`seek(now())` moves a playhead that is now inside the cut to the new end — Review Focus 1.)

- [ ] **Step 7: Scene panel length row.** In `scenePane`, after the `.ph2` block's closing `</div>` (the line ending `data-tip-id="status">i</button></div>`), add:

```js
    ${sceneLen(s) < s.t[1] - s.t[0] - 1e-6 ? `<div class="f changed"><div class="fl">Length ${(s.t[1] - s.t[0]).toFixed(1)}s → ${sceneLen(s).toFixed(1)}s<button class="info" data-tip-id="trim">i</button><span class="sp"></span><button class="undo" data-undo="${s.id}.@len">Undo</button></div></div>` : ''}
```

Add to `TIPS`: `trim:'This scene is cut short: it plays as before but stops sooner, and every later scene moves earlier. Drag its end on the timeline to change it.',`. The existing `[data-undo]` branch deletes the path and calls `changed()`; also call `seek(now())` there is not needed (Undo only lengthens).

- [ ] **Step 8: Browser check on qbot-tag (mp4).** Start the qbot server, open `http://localhost:4400`, then:

```bash
T
E "(() => { const b = document.querySelector('[data-trim]').getBoundingClientRect(), y = b.top + b.height / 2;
  const fire = (el, type, x) => el.dispatchEvent(new PointerEvent(type, {bubbles:true, clientX:x, clientY:y, pointerId:1}));
  const h = document.querySelector('[data-trim]'); fire(h, 'pointerdown', b.right - 2); fire(window, 'pointermove', b.right - 120); fire(window, 'pointerup', b.right - 120);
  const s = P.scenes[0]; return JSON.stringify([s.t[1] - s.t[0], sceneLen(s), +edDur().toFixed(2), P.duration, document.querySelector('#tc').textContent]); })()"
chrome-devtools-axi screenshot $S/trim-qbot.png
E "(() => { const s = P.scenes[0]; seek(sceneEnd(s) - 0.4); play(); return 1; })()"; sleep 1.5
E "(() => { pause(); return JSON.stringify([now().toFixed(2), sceneAt(now()).id, isCut(now())]); })()"
```

Expected: scene 1 shorter than its original, total edited duration smaller by the same amount, timecode shows the new total; screenshot shows S1's block narrower with its length in accent colour, later blocks moved left, handle visible; after playing across the cut, `now()` is in scene 2 and `isCut` is false. Then Undo: `E "(() => { document.querySelector('[data-undo$=\".@len\"]').click(); return +edDur().toFixed(2); })()"` → equals `P.duration` (select scene 1 first if the panel shows another scene: `E "(() => { ui.scene = P.scenes[0].id; ui.tab='scene'; renderPane(); return 1; })()"`). Stop the qbot server.

- [ ] **Step 9: Checkpoint.** Commit only if okayed.

---

### Task 3: Prompt, live clock and export body

**Files:**
- Modify: `player/index.html` — `prompt()` (~873-885), `liveVideo` (~440-456), `drawGhosts` live line (~509), `syncMusic` (~476), export fetch body (~905); `selftest()`.

**Interfaces:**
- Consumes: Task 1 clocks; `keepAfterNewVersion(over, snap)` (existing).
- Produces: `sceneLens(): Record<sid, number>` (only trimmed scenes); live API optional `setScenes(lens)`.

- [ ] **Step 1: Write the failing tests.** Append inside `selftest()`'s `try`, before `} finally`:

```js
    // prompt and live payload carry trims
    st.over = {[`${s0.id}.@len`]: L0};
    eq(sceneLens(), {[s0.id]: L0}, 'scene lengths for the renderer');
    const pr = prompt();
    eq(pr.includes('## Trims (apply last)') && pr.includes(`${s0.id} ${s0.name}: ${(O0).toFixed(1)}s -> ${L0.toFixed(1)}s`), true, 'prompt has the trim');
    eq(pr.includes('Times are in the current render (before trims).'), true, 'prompt says which clock');
    eq(keepAfterNewVersion({[`${s0.id}.@len`]: L0}, {[`${s0.id}.@len`]: L0}), {}, 'sent trim dropped on new version');
```

- [ ] **Step 2: Run to verify it fails.** Reload, `T` → `FAIL sceneLens is not defined`.

- [ ] **Step 3: Implement prompt and payload.** After `function liveBoxes(){...}` add:

```js
const sceneLens = () => Object.fromEntries(P.scenes.filter(s => `${s.id}.@len` in st.over).map(s => [s.id, sceneLen(s)]));
```

In `prompt()`:
- the `edits` filter `!k.endsWith('.motion')` → `!k.endsWith('.motion') && !k.endsWith('.@len')`.
- after the `L` initialiser line add: `const trims = Object.entries(st.over).filter(fresh).filter(([k]) => k.endsWith('.@len'));` and, if `trims.length`, push `'Times are in the current render (before trims).'` and `''` right after the Project line: `if (trims.length) L.push('Times are in the current render (before trims).', '');`
- before `L.push('## Scenes', ...)` add:

```js
  if (trims.length) { L.push('## Trims (apply last)');
    trims.forEach(([k]) => { const s = sceneOf(k.split('.')[0]), O = s.t[1] - s.t[0], Ln = sceneLen(s), cut = O - Ln;
      L.push(`- ${s.id} ${s.name}: ${O.toFixed(1)}s -> ${Ln.toFixed(1)}s. Drop ${(s.t[0] + Ln).toFixed(2)}s-${s.t[1].toFixed(2)}s of the current render; everything after moves ${cut.toFixed(2)}s earlier.`); });
    L.push(''); }
```

- in the `## Do` line, after `Apply the edits exactly and work through the notes.` insert ` Apply trims last.`

- [ ] **Step 4: Run to verify it passes.** Reload, `T` → `selftest ok`.

- [ ] **Step 5: Live clock, scenes sync, music, export.**

In `liveVideo`:
- getter: `return p() ? p().getCurrentFrame() / P.fps : t0;` → `return p() ? toSrc(p().getCurrentFrame() / P.fps) : t0;`
- setter: `p().seekTo(Math.round(t * P.fps))` → `p().seekTo(Math.round(toEd(t) * P.fps))`
- the initial `p().seekTo(Math.round(t0 * P.fps))` → `p().seekTo(Math.round(toEd(t0) * P.fps))`

In `drawGhosts`, replace the live line with:

```js
  if (live) { const j = JSON.stringify(liveBoxes()); if (j !== sentBoxes) { sentBoxes = j; live.setBoxes(JSON.parse(j)); }
    const sj = JSON.stringify(sceneLens()); if (live.setScenes && sj !== sentScenes) { sentScenes = sj; live.setScenes(JSON.parse(sj)); } return; }
```

and declare `let sentScenes = '{}';` next to `let sentBoxes = '';`.

`syncMusic`: `music.currentTime = now();` → `music.currentTime = toEd(now());`

Export fetch body: `JSON.stringify({boxes:liveBoxes()})` → `JSON.stringify({boxes:liveBoxes(), scenes:sceneLens()})`.

- [ ] **Step 6: Run the tests again on both projects.** `T` on 4321 and 4400 → `selftest ok`. (Herdcats' current bundle has no `setScenes` yet, so its timeline must show no `[data-trim]`: `E "document.querySelectorAll('[data-trim]').length"` → `0`.)

- [ ] **Step 7: Checkpoint.** Commit only if okayed.

---

### Task 4: Herdcats renderer lays scenes out from `scenes`

**Files:**
- Create: `src/trim.ts`, `src/trim.check.ts`
- Modify: `src/Main.tsx`, `src/index.ts`, `src/live.tsx`, `reel.json` (lines 803-805)
- Rebuild: `motion-os-axi-live.js`

**Interfaces:**
- Consumes: `scenes` prop `{sid: seconds}` from Task 3.
- Produces: `Lens = Record<string, number>`, `sceneLen(id: string, lens: Lens): number`, `totalLen(lens: Lens): number`; `MotionOSAXILive(el)` returns `{ref, setBoxes, setRate, setScenes}`.

- [ ] **Step 1: Back up.** `cd /Users/zhiyaochan/Projects/ios-app/herdcats-launch-video && mkdir -p $S/herdcats-backup-trim && cp -R src motion-os-axi-live.js reel.json $S/herdcats-backup-trim/`

- [ ] **Step 2: Failing check** `src/trim.check.ts`:

```ts
import {sceneLen, totalLen} from './trim';

const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
eq(totalLen({}), 46, 'untrimmed total');
eq(sceneLen('S2', {}), 4, 'untrimmed scene');
eq(sceneLen('S2', {S2: 3}), 3, 'trimmed scene');
eq(sceneLen('S2', {S2: 9}), 4, 'never longer than the original');
eq(totalLen({S2: 3, S5: 4.5}), 44.5, 'trims shorten the total');
console.log('trim check ok');
```

- [ ] **Step 3: Run it to verify it fails.** `npx esbuild src/trim.check.ts --bundle --platform=node --log-level=error | node` → `Could not resolve "./trim"`.

- [ ] **Step 4: Implement** `src/trim.ts`:

```ts
import reel from '../reel.json';

/** Motion OS AXI scene trims: edited scene lengths in seconds, only for trimmed scenes. */
export type Lens = Record<string, number>;

const orig = (id: string) => { const [a, b] = reel.scenes.find((s) => s.id === id)!.t as [number, number]; return b - a; };
export const sceneLen = (id: string, lens: Lens) => Math.min(lens[id] ?? orig(id), orig(id));
export const totalLen = (lens: Lens) => reel.scenes.reduce((n, s) => n + sceneLen(s.id, lens), 0);
```

- [ ] **Step 5: Run it to verify it passes.** Same command → `trim check ok`.

- [ ] **Step 6: Use it.**

`src/Main.tsx`: add `import {Lens, sceneLen} from './trim';` and replace the `Main` component with:

```tsx
/** `boxes` keys are Motion OS AXI element ids ("s3-headline"); each scene sees them without its prefix.
 *  `scenes` trims scenes (cut their tails); later scenes start earlier. */
export const Main: React.FC<{boxes?: Boxes; scenes?: Lens}> = ({boxes = {}, scenes = {}}) => {
  let at = 0;
  return (
    <AbsoluteFill style={{background: C.canvas}}>
      {reel.scenes.map((s) => {
        const [a] = sceneT(s.id);
        const len = sceneLen(s.id, scenes);
        const from = Math.round(at * reel.fps);
        at += len;
        const Comp = SCENES[s.id];
        const pre = s.id.toLowerCase() + '-';
        const scoped = Object.fromEntries(Object.entries(boxes).filter(([k]) => k.startsWith(pre)).map(([k, v]) => [k.slice(pre.length), v]));
        return (
          <Sequence key={s.id} from={from} durationInFrames={Math.round(len * reel.fps)} name={s.name}>
            {/* keyframe times are in the untrimmed render's clock, so Ed gets the scene's original start */}
            <SceneFromCtx.Provider value={Math.round(a * reel.fps)}>
              <BoxesCtx.Provider value={scoped}>
                <Comp qr={staticFile('qr.png')} />
              </BoxesCtx.Provider>
            </SceneFromCtx.Provider>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
```

`src/index.ts`: import `{totalLen}` from `'./trim'` and give the composition:

```ts
    durationInFrames: Math.round(reel.duration * reel.fps),
    calculateMetadata: ({props}: {props: any}) => ({durationInFrames: Math.round(totalLen(props.scenes ?? {}) * reel.fps)}),
    ...
    defaultProps: {boxes: {}, scenes: {}},
```

`src/live.tsx`: import `{Lens, totalLen}` from `'./trim'`; add `let scenes: Lens = {};`; Player gets `inputProps={{boxes, scenes}}` and `durationInFrames={Math.round(totalLen(scenes) * reel.fps)}`; return object gains `setScenes: (l: Lens) => { scenes = l; draw(); },`.

`reel.json` lines 803-805: `"props": {\n      "boxes": {}\n    },` → `"props": {\n      "boxes": {},\n      "scenes": {}\n    },` (string edit; don't re-serialise the file).

- [ ] **Step 7: Type-check, rebuild, re-run checks.**

```bash
npx tsc --noEmit; echo "tsc exit $?"
npx esbuild src/live.tsx --bundle --format=iife --minify --define:process.env.NODE_ENV='"production"' --outfile=motion-os-axi-live.js --log-level=warning
npx esbuild src/trim.check.ts --bundle --platform=node --log-level=error | node
npx esbuild src/keys.check.ts --bundle --platform=node --log-level=error | node
python3 -c "import json; json.load(open('reel.json')); print('reel ok')"
```

Expected: `tsc exit 0`, `trim check ok`, `keys check ok`, `reel ok`. Reload `localhost:4321`: `T` → `selftest ok`; `E "document.querySelectorAll('[data-trim]').length"` → `7`.

- [ ] **Step 8: Checkpoint.** Backup in `$S/herdcats-backup-trim` is the rollback.

---

### Task 5: SKILL.md and Herdcats end-to-end

**Files:**
- Modify: `SKILL.md` (section 4 "Live projects", section 5 user intro, section 6 "Apply feedback")

- [ ] **Step 1: Live projects.** After the `Ed` bullet in section 4, add:

```markdown
- Lay scenes out from a `scenes` prop (`{"S2": 3.0}`: edited lengths in seconds, only trimmed scenes): each scene's `Sequence` starts where the previous edited one ends and lasts its edited length (never longer than the original). Compute the composition's `durationInFrames` from those lengths with `calculateMetadata`, and add `setScenes(lens)` to `MotionOSAXILive` (re-render the Player with the new `scenes` and duration). Keyframe times stay in the untrimmed clock, so `Ed`'s scene start is the scene's original `t[0]`, not its new start. Put `"scenes": {}` next to `"boxes": {}` in `export.props`. Without `setScenes` the player offers no trimming.
```

- [ ] **Step 2: User intro (section 5).** After `press K at two moments to animate an element between them,` insert `drag a scene's end on the timeline to shorten it,`.

- [ ] **Step 3: Apply feedback (section 6).** After the Keyframes bullet, add:

```markdown
- **Trims** come last, as `S2 Reveal: 4.0s -> 3.0s. Drop 14.00s-15.00s ...; everything after moves 1.00s earlier.` All other times in the prompt are in the current render, so apply them first. Then cut the scene in code (its `Sequence` duration or equivalent; don't speed it up), set its `t[1]` in `reel.json`, shift every later scene's `t`, their elements' `t` and keyframe/note times by the cut, clamp elements that ran past the new end, and update `duration`.
```

- [ ] **Step 4: Read back** `git diff SKILL.md`.

- [ ] **Step 5: End-to-end on Herdcats.** On `localhost:4321` (clear the headless browser's storage first: `E "(() => { localStorage.clear(); return 1; })()"`, reload):

```bash
# trim S1 (0-11s) to 9s via the API the drag uses, and keyframe the S2 tagline 12s -> 14s (render time)
E "(() => { set('S1.@len', 9, 11); const e = elById('s2-tagline'); addKey(e, e.box, 12); addKey(e, [5, 44, 60, 12], 14); renderAll(); return JSON.stringify([edDur(), sceneLens()]); })()"
E "(() => { seek(13.5); return 1; })()"; sleep 1
E "(() => JSON.stringify([now().toFixed(2), toEd(now()).toFixed(2), document.querySelector('#tc').textContent]))()"
chrome-devtools-axi screenshot $S/trim-herdcats.png
E "(() => { document.querySelector('#exportBtn').click(); return 1; })()"
until curl -s localhost:4321/export | grep -q '"state":"done"\|"state":"error"'; do sleep 10; done; curl -s localhost:4321/export
cd /Users/zhiyaochan/Projects/ios-app/herdcats-launch-video && OUT=$(ls -t exports/*.mp4 | head -1)
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT"
for t in 8.9 9.1; do ffmpeg -v error -y -ss $t -i "$OUT" -frames:v 1 -vf scale=640:-1 "$S/tx-$t.png"; done
ffmpeg -v error -y -ss 8.9 -i video.mp4 -frames:v 1 -vf scale=640:-1 "$S/to-8.9.png"; ffmpeg -v error -y -ss 11.1 -i video.mp4 -frames:v 1 -vf scale=640:-1 "$S/to-11.1.png"
# keyframe check: tagline right edge at edited 11.5s (render 13.5s) should be 270px left of the original at 13.5s
ffmpeg -v error -ss 11.5 -i "$OUT" -frames:v 1 -vf "crop=1920:130:0:475,format=gray" -f rawvideo - | python3 -c "import sys; d=sys.stdin.buffer.read(); W=1920; H=len(d)//W; c=[x for x in range(W) if any(d[y*W+x]>150 for y in range(H))]; print('export right edge', c[-1] if c else None)"
ffmpeg -v error -ss 13.5 -i video.mp4 -frames:v 1 -vf "crop=1920:130:0:475,format=gray" -f rawvideo - | python3 -c "import sys; d=sys.stdin.buffer.read(); W=1920; H=len(d)//W; c=[x for x in range(W) if any(d[y*W+x]>150 for y in range(H))]; print('orig right edge', c[-1] if c else None)"
```

Expected:
- `edDur` 44, `sceneLens` `{"S1": 9}`; at render 13.5s the timecode reads `00:11.5 / 00:44.0`.
- Screenshot: S1 block shows 9.0s in accent, later blocks shifted, ◆ diamonds under S2 at its new position.
- Export `done`; ffprobe duration ≈ 44.0.
- `tx-8.9` matches `to-8.9` (still S1); `tx-9.1` matches `to-11.1` (S2 has started). Read the four images.
- Export right edge = orig right edge − 270 (797 → 527 per the keyframes run): keyframes on the later scene stayed on their content (Review Focus 2).

Then check the prompt: `E "(() => { document.querySelector('#sendBtn').click(); return document.querySelector('.sheet textarea').value; })()"` contains `## Trims (apply last)` and `S1 Cold open: blocked agent: 11.0s -> 9.0s`; press Escape (don't copy).

- [ ] **Step 6: Clean up.** `E "(() => { localStorage.clear(); return 1; })()"`; delete the test export (`rm "$OUT"`, and `rmdir exports` if empty).

- [ ] **Step 7: Checkpoint.** Commit only if okayed.
