# Keyframes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Motion OS user give one element two keyframes (position and size at two moments) so it glides between them with ease in-out, live in the player, in Export MP4, and in the Send to Claude prompt.

**Architecture:** The player stores keyframes as one more override path (`<id>.@keys`) next to `@box`/`@time`, and a pure `keyBox(keys, t)` gives the box at any time. Everything that already reads an element's box (overlay, drag, ghost preview) goes through `elBox`, which now uses `keyBox` when keys exist. Live projects receive `{box, keys}` in `boxes[id]`; their `Ed` wrapper does the same math per frame using absolute video time.

**Tech Stack:** Plain HTML/JS (no build) for the player; Remotion 4 + React 18 + esbuild for the Herdcats live renderer; ffmpeg for frame checks; `chrome-devtools-axi` for browser checks.

**Spec:** `docs/specs/2026-10-09-keyframes-design.md` (the spec's `boxAt` is implemented as `keyBox` + `elBox`).

## Global Constraints

- Position and size only (`[x, y, w, h]` in % of frame). No opacity, no rotation.
- At most 2 keyframes per element.
- Easing is always ease in-out: `p < .5 ? 4p³ : 1 - (-2p + 2)³ / 2`.
- Hold the first box before the first keyframe and the last box after the last.
- Keyframe `t` is absolute video seconds, rounded to 1/fps.
- An element has either `@box` or `@keys`, never both.
- Old `boxes[id]` arrays (`[x, y, w, h, nx, ny, nw, nh]`) must keep working.
- No new dependencies in the player; it stays one `index.html`.
- Commits: the user has asked to hold commits. Each task ends with a checkpoint; only run `git commit` once the user says so. The Herdcats project is not a git repo, so Task 4 backs it up first.

## Review Focus

1. An element already moved with a static `@box`, then K: the first keyframe must use the moved box, and `@box` must disappear. (Task 2 Step 1)
2. Editing a keyframe's time so the two swap order: keys must re-sort and the glide still go first → second in time. (Task 2 Step 1)
3. Deleting one of two keyframes: element holds the remaining box at all times; deleting the last: element is back where reel.json puts it. (Task 2 Step 1)
4. Dragging with 2 keyframes while not on either: box unchanged, toast shown, nothing saved. (Task 2 Step 1)
5. A keyframed element in a scene that doesn't start at 0 (e.g. S2 at 11s): the live render must hit the keyframe boxes at the absolute times, not shifted by the scene start. (Task 4 Step 1, Task 5 Step 4)

---

## File Structure

- `player/index.html` (modify): keyframe math, state helpers, UI, prompt line, live payload, `selftest()`.
- `SKILL.md` (modify): new `boxes` shape, `Ed` example with keys, how to apply keyframe feedback.
- `/Users/zhiyaochan/Projects/ios-app/herdcats-launch-video/src/keys.ts` (create): pure `easeInOut`, `keyBox`, `editAt` for the renderer.
- `/Users/zhiyaochan/Projects/ios-app/herdcats-launch-video/src/keys.check.ts` (create): assertions for `keys.ts`.
- `/Users/zhiyaochan/Projects/ios-app/herdcats-launch-video/src/lib.tsx` (modify): `Boxes` type, `SceneFromCtx`, `Ed` uses `editAt`.
- `/Users/zhiyaochan/Projects/ios-app/herdcats-launch-video/src/Main.tsx` (modify): provide each scene's start frame.
- `/Users/zhiyaochan/Projects/ios-app/herdcats-launch-video/motionos-live.js` (rebuild).

Browser checks below use:

```bash
export CHROME_DEVTOOLS_AXI_SESSION=motionos
E() { chrome-devtools-axi eval "$1"; }
```

and the Herdcats player already running at `http://localhost:4321` (start it with `node ~/.claude/skills/motion-os/player/serve.mjs /Users/zhiyaochan/Projects/ios-app/herdcats-launch-video --no-open` if it isn't).

---

### Task 1: Keyframe math and `elBox` in the player

**Files:**
- Modify: `player/index.html` (helpers near line 341 `const ease = ...`; accessors near line 376 `const elBox = ...`; append `selftest()` before the final `// Load reel.json` block near line 869)

**Interfaces:**
- Produces: `easeInOut(p: number): number`, `keyBox(keys: {t, box}[], t: number): number[]`, `fps1(t: number): number`, `elKeys(e): {t, box}[] | null`, `elBox(e): number[]` (now time-aware), `selftest(): 'selftest ok'` (throws on failure).

- [ ] **Step 1: Write the failing test.** Add before the `// Load reel.json` comment:

```js
/* ================= selftest: run selftest() in the browser console ================= */
function selftest(){
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
  const A = {t:2, box:[0, 0, 10, 10]}, B = {t:4, box:[20, 40, 30, 30]};
  eq(easeInOut(0), 0, 'ease 0'); eq(easeInOut(1), 1, 'ease 1'); eq(easeInOut(0.5), 0.5, 'ease mid'); eq(easeInOut(0.25), 0.0625, 'ease quarter');
  eq(keyBox([A], 9), A.box, 'one key holds');
  eq(keyBox([A, B], 1), A.box, 'before holds first');
  eq(keyBox([A, B], 2), A.box, 'on first');
  eq(keyBox([A, B], 3), [10, 20, 20, 20], 'midpoint is halfway');
  eq(keyBox([A, B], 4), B.box, 'on last');
  eq(keyBox([A, B], 5), B.box, 'after holds last');
  return 'selftest ok';
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `chrome-devtools-axi open http://localhost:4321 && E "(() => { try { return selftest(); } catch (e) { return 'FAIL ' + e.message; } })()"`
Expected: `FAIL easeInOut is not defined`

- [ ] **Step 3: Implement.** After `const ease = ...` (line 341) add:

```js
const easeInOut = p => (p = clamp(p), p < .5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
// Box at time t from 1 or 2 keyframes [{t, box}] (sorted): held before the first and after the last, eased in between.
function keyBox(keys, t){
  const [a, b] = keys;
  if (!b || t <= a.t) return a.box;
  if (t >= b.t) return b.box;
  const p = easeInOut((t - a.t) / (b.t - a.t));
  return a.box.map((v, i) => Math.round((v + (b.box[i] - v) * p) * 10) / 10);
}
```

Replace line 376 `const elBox = e => get(\`${e.id}.@box\`, e.box);` with:

```js
const fps1 = t => Math.round(t * P.fps) / P.fps;
const elKeys = e => get(`${e.id}.@keys`, null);
const elBox = e => { const k = elKeys(e); return k ? keyBox(k, now()) : get(`${e.id}.@box`, e.box); };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: reload, then `E "selftest()"`
Expected: `selftest ok`. Also `E "document.querySelectorAll('.sb').length"` returns the scene count (page still loads).

- [ ] **Step 5: Checkpoint.** `git -C /Users/zhiyaochan/Projects/skills/motion-os diff --stat` shows only `player/index.html`. Commit only if the user has okayed commits: `git add player/index.html && git commit -m "player: keyframe math (keyBox, easeInOut) and time-aware elBox"`.

---

### Task 2: Adding, editing and dragging keyframes

**Files:**
- Modify: `player/index.html` (state helpers after `touchScene` near line 710; `pointerdown`/`pointermove` near lines 516-535; transport HTML near line 302; keydown handler near line 863; `TIPS` near line 320)

**Interfaces:**
- Consumes: `keyBox`, `fps1`, `elKeys`, `elBox` (Task 1).
- Produces: `onKey(keys, t): number` (index or -1), `setKeys(e, keys): void`, `addKey(e, box?, t?): void`, `moveTo(e, box): boolean` (false = refused), `keyTarget(): element | null`, `keyNow(): void`, button `#keyBtn`.

- [ ] **Step 1: Write the failing tests.** Append inside `selftest()` before `return`:

```js
  // state helpers, on a scratch copy of the edits
  // vid is swapped for a stub so now() is exact (a live Remotion player seeks asynchronously)
  const saved = JSON.stringify(st.over), realVid = vid, e = allEls().find(x => x.box), id = e.id, T0 = e.t[0] + 0.5, T1 = Math.min(e.t[1] - 0.1, T0 + 1.5);
  vid = {currentTime:0, paused:true, pause(){}};
  try {
    st.over = {}; set(`${id}.@box`, [1, 2, e.box[2], e.box[3]], e.box);
    vid.currentTime = T0; addKey(e);
    eq(elKeys(e), [{t:fps1(T0), box:[1, 2, e.box[2], e.box[3]]}], 'first key takes the moved box');
    eq(`${id}.@box` in st.over, false, '@box removed');
    vid.currentTime = T1; eq(moveTo(e, [5, 6, e.box[2], e.box[3]]), true, 'drag adds second key');
    eq(elKeys(e).length, 2, 'two keys');
    vid.currentTime = (T0 + T1) / 2; eq(moveTo(e, [9, 9, 9, 9]), false, 'drag off-key refused');
    eq(elKeys(e)[1].box, [5, 6, e.box[2], e.box[3]], 'refused drag changed nothing');
    vid.currentTime = T1; moveTo(e, [7, 7, e.box[2], e.box[3]]); eq(elKeys(e)[1].box, [7, 7, e.box[2], e.box[3]], 'drag on key edits it');
    setKeys(e, [{...elKeys(e)[0], t:fps1(T1 + 0.5)}, elKeys(e)[1]]); eq(elKeys(e).map(k => k.box[0]), [7, 1], 'keys re-sort by time');
    setKeys(e, [elKeys(e)[0]]); vid.currentTime = 0; eq(elBox(e), [7, 7, e.box[2], e.box[3]], 'one key left holds');
    setKeys(e, []); eq(`${id}.@keys` in st.over, false, 'no keys removes the path'); eq(elBox(e), e.box, 'back to reel.json box');
  } finally { vid = realVid; st.over = JSON.parse(saved); markDirty(); }
```

Note: `vid` is declared with `let` (line 343), so the stub swap works; `now()` reads `vid.currentTime`.

- [ ] **Step 2: Run to verify it fails**

Run: reload, `E "(() => { try { return selftest(); } catch (e) { return 'FAIL ' + e.message; } })()"`
Expected: `FAIL addKey is not defined`

- [ ] **Step 3: Implement the helpers.** After `function touchScene(sid){ ... }` add:

```js
/* keyframes: "<id>.@keys" = [{t, box}], 1 or 2, sorted. Replaces "<id>.@box" for that element. */
const onKey = (keys, t) => keys ? keys.findIndex(k => Math.abs(k.t - t) < 0.5 / P.fps) : -1;
function setKeys(e, keys){
  delete st.over[`${e.id}.@box`];
  if (keys.length) st.over[`${e.id}.@keys`] = [...keys].sort((a, b) => a.t - b.t); else delete st.over[`${e.id}.@keys`];
  touchScene(e.s); markDirty();
}
// Add a keyframe at t (default: now, with the box shown now). On a keyframe: update it. With 2 already: replace the nearer.
function addKey(e, box = elBox(e), t = fps1(now())){
  const keys = (elKeys(e) || []).map(k => ({...k})), i = onKey(keys, t);
  if (i >= 0) keys[i].box = box;
  else if (keys.length < 2) keys.push({t, box});
  else keys[Math.abs(keys[0].t - t) <= Math.abs(keys[1].t - t) ? 0 : 1] = {t, box};
  setKeys(e, keys);
}
// Where a drag or box field lands: a plain move, a keyframe, or a new second keyframe. False when it can't (2 keys, not on one).
function moveTo(e, box){
  const keys = elKeys(e), t = fps1(now());
  if (!keys) { set(`${e.id}.@box`, box, e.box); touchScene(e.s); return true; }
  if (onKey(keys, t) < 0 && keys.length >= 2) return false;
  addKey(e, box, t); return true;
}
const keyTarget = () => { const e = ui.mode === 'edit' && ui.sel && elById(ui.sel); return e && e.box && e.s === ui.scene && boxOf(e) ? e : null; };
function keyNow(){
  const e = keyTarget(); if (!e) return toast('In Edit, select something on screen first, then press K.');
  pause(); addKey(e); renderPane(); changed(); toast(`Keyframe at ${fmt(fps1(now()))}`);
}
```

- [ ] **Step 4: Wire drag.** In the `pointerdown` handler, after `if (!g) { ... }` and before `pause(); drag = ...`, add:

```js
  const ks = elKeys(g.sel); if (ks && ks.length >= 2 && onKey(ks, fps1(now())) < 0) { toast('Jump to a keyframe to change it'); return; }
```

In `pointermove`, replace `set(\`${drag.e.id}.@box\`, nb.map(r1), drag.e.box); touchScene(drag.e.s); renderHots();` with:

```js
  moveTo(drag.e, nb.map(r1)); renderHots();
```

- [ ] **Step 5: Wire K and the ◆ button.** In the transport, after the `#noteBtn` button, add:

```html
        <button class="ib" id="keyBtn" aria-label="Add keyframe" data-tip="Keyframe (K). In Edit, saves the selected element's position and size at this moment. Add a second one somewhere else and it glides between them."><svg viewBox="0 0 16 16"><path d="M8 2l6 6-6 6-6-6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button>
```

Next to `$('#noteBtn').onclick = ...` add `$('#keyBtn').onclick = keyNow;`. In the keydown chain, after the `n`/`N` branch, add:

```js
  else if (ev.key === 'k' || ev.key === 'K') keyNow();
```

In the shortcuts tip (`data-tip="Space play · ..."`), add ` · K keyframe` after `N note mode`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: reload, `E "selftest()"`
Expected: `selftest ok`. Then `E "(() => { setMode('edit'); const e = allEls().find(x => x.box && x.s === ui.scene); selectEl(e.id); keyNow(); return JSON.stringify(elKeys(e)); })()"` returns one keyframe; clean up with `E "(() => { localStorage.clear(); location.reload(); return 1; })()"`.

- [ ] **Step 7: Checkpoint.** Commit only if okayed: `git add player/index.html && git commit -m "player: add, drag and replace keyframes (K, ◆ button)"`.

---

### Task 3: Keyframes on screen — timeline, panel, preview, prompt, live payload

**Files:**
- Modify: `player/index.html` (CSS near line 131 `.tp`; `renderTL` near line 569; `#tl` pointerdown near line 582; `elCard` near line 615 plus new `keysHTML` after `boxHTML`; panel `input`/`click` handlers near lines 719-752; deselect paths near lines 520 and 740; `liveBoxes` near line 434; `drawGhosts` near line 485; `describe` near line 788; `TIPS`)

**Interfaces:**
- Consumes: `elKeys`, `setKeys`, `fps1`, `keyBox` (Tasks 1-2).
- Produces: `keysHTML(e): string`; `liveBoxes()` now returns `Record<id, number[8] | {box: number[4], keys: {t, box}[]}>`.

- [ ] **Step 1: Write the failing tests.** Append inside `selftest()`'s `try` block, before `} finally`:

```js
    setKeys(e, [{t:fps1(T0), box:e.box}, {t:fps1(T1), box:[5, 6, e.box[2], e.box[3]]}]);
    eq(liveBoxes()[id], {box:e.box, keys:elKeys(e)}, 'live payload carries keys');
    eq(describe(`${id}.@keys`, elKeys(e)).includes(`keyframes, ease in-out`), true, 'prompt line');
    eq(describe(`${id}.@keys`, elKeys(e)).includes(`${+fps1(T0).toFixed(2)}s ${JSON.stringify(e.box)} -> `), true, 'prompt has both keys');
    st.over = {}; set(`${id}.@box`, [1, 2, 3, 4], e.box); eq(liveBoxes()[id], [...e.box, 1, 2, 3, 4], 'old payload for plain moves');
```

- [ ] **Step 2: Run to verify it fails**

Run: reload, `E "(() => { try { return selftest(); } catch (e) { return 'FAIL ' + e.message; } })()"`
Expected: `FAIL live payload carries keys: ...` (old `liveBoxes` ignores `@keys`).

- [ ] **Step 3: Live payload and ghost preview.** Replace `liveBoxes()` with:

```js
function liveBoxes(){  // edited boxes the composition needs: id -> [base box, new box], or {box: base, keys} when keyframed
  const b = {};
  for (const e of allEls()) {
    if (!e.box) continue;
    const k = elKeys(e), m = get(`${e.id}.@box`, null);
    if (k) b[e.id] = {box:e.box, keys:k}; else if (m) b[e.id] = [...e.box, ...m];
  }
  return b;
}
```

In `drawGhosts`, change `if (!e.box || !(\`${e.id}.@box\` in st.over)) continue;` to:

```js
    if (!e.box || !(`${e.id}.@box` in st.over || `${e.id}.@keys` in st.over)) continue;
```

(`boxOf` → `elBox` already interpolates, and `vframe` → `tick` → `renderHots` → `drawGhosts` runs every frame while playing.)

- [ ] **Step 4: Prompt line.** In `describe`, right after `const [id, k] = path.split('.'), e = elById(id);` add:

```js
  if (k === '@keys') { const src = e.src ? ` (${e.src})` : '';
    return v.length === 1
      ? `- [${fmt(v[0].t)} · ${e.s} · ${e.label}] size and position, [x, y, w, h] in % of frame${src}: ${JSON.stringify(e.box)} -> ${JSON.stringify(v[0].box)}`
      : `- [${fmt(v[0].t)} · ${e.s} · ${e.label}] keyframes, ease in-out, [x, y, w, h] in % of frame${src}: ${v.map(x => `${+x.t.toFixed(2)}s ${JSON.stringify(x.box)}`).join(' -> ')}`; }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: reload, `E "selftest()"` → `selftest ok`.

- [ ] **Step 6: Timeline row.** CSS, after the `.tp{...}` rule:

```css
.trk.keys{height:14px}
.kf{position:absolute;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;transform:rotate(45deg);background:var(--accent);border:1.5px solid var(--panel);cursor:pointer;z-index:1}
.kl{position:absolute;top:50%;height:2px;margin-top:-1px;background:var(--accent);opacity:.4}
.kf-go{border:0;background:none;color:var(--accent);padding:0 0 7px;font-size:13px}
.f .x{border:0;background:none;color:var(--faint);padding:0 0 6px;font-size:15px}
```

In `renderTL`, before the `$('#tl').innerHTML = ...` line add:

```js
  const ke = ui.sel && elById(ui.sel), keys = ke && elKeys(ke);
  const keyRow = keys ? `<div class="trk keys">${keys.length === 2 ? `<span class="kl" style="left:${pct(keys[0].t)};width:${pct(keys[1].t - keys[0].t)}"></span>` : ''}${keys.map(k => `<span class="kf" data-key-t="${k.t}" style="left:${pct(k.t)}" data-tip="${esc(ke.label)} keyframe at ${fmt(k.t)}"></span>`).join('')}</div>` : '';
```

then insert `${keyRow}` right after the `<div class="trk pins">...</div>` line in the template.

In the `#tl` `pointerdown` handler, first line, add:

```js
  const kf = ev.target.closest('[data-key-t]'); if (kf) { pause(); return seek(+kf.dataset.keyT); }
```

Selection changes must redraw the timeline: in `overlay` `pointerdown`, change `if (ui.sel) { ui.sel = null; renderPane(); renderHots(); } return;` to `if (ui.sel) { ui.sel = null; renderPane(); renderTL(); renderHots(); } return;`, and in the panel `[data-pick]` branch change `(ui.sel = null, renderPane(), renderHots())` to `(ui.sel = null, renderPane(), renderTL(), renderHots())`. (`selectEl` and `changed()` already call `renderTL`.)

- [ ] **Step 7: Panel section.** In `elCard`, replace `${boxHTML(e)}` with `${elKeys(e) ? keysHTML(e) : boxHTML(e)}`. After `function boxHTML(e){...}` add:

```js
function keysHTML(e){
  const keys = elKeys(e);
  const n = (i, ix, l, v, step) => `<label class="fl" style="gap:4px">${l}<input type="number" step="${step}" data-key="${e.id}" data-i="${i}" data-ix="${ix}" value="${v}"></label>`;
  return `<div class="f changed"><div class="fl">Keyframes<button class="info" data-tip-id="keys">i</button><span class="sp"></span><button class="undo" data-undo="${e.id}.@keys">Undo</button></div>
    ${keys.map((k, i) => `<div class="row2" style="grid-template-columns:auto 1fr 1fr 1fr 1fr 16px;align-items:end"><button class="kf-go" data-seek="${k.t}" aria-label="Go to keyframe">◆</button>${n(i, 't', 'Time', +k.t.toFixed(2), +(1 / P.fps).toFixed(4))}${n(i, 0, 'X', k.box[0], 0.5)}${n(i, 1, 'Y', k.box[1], 0.5)}${n(i, 's', 'Scale %', Math.round(k.box[2] / e.box[2] * 100), 5)}<button class="x" data-del-key="${e.id}" data-i="${i}" aria-label="Delete keyframe">×</button></div>`).join('')}
    ${keys.length < 2 ? `<div class="fl">Go to another moment and press K, or drag it, to add the second keyframe.</div>` : ''}</div>`;
}
```

Add to `TIPS`: `keys:'Where it is at two moments. It glides between them with ease in-out. In Edit, press K to add one at the playhead.',`

In the panel `input` handler, before `if (d.bcolor)`, add:

```js
  if (d.key) { const e = elById(d.key), keys = elKeys(e).map(k => ({...k, box:[...k.box]})), k = keys[+d.i], v = Number(t.value); if (!t.value || isNaN(v)) return;
    if (d.ix === 't') k.t = fps1(clamp(v, 0, P.duration));
    else if (d.ix === 's') { const s = Math.max(10, v) / 100; k.box[2] = Math.round(e.box[2] * s * 10) / 10; k.box[3] = Math.round(e.box[3] * s * 10) / 10; }
    else k.box[+d.ix] = v;
    setKeys(e, keys); return changed(); }
```

In the panel `click` handler, before `if (b = q('[data-swap]'))`, add:

```js
  if (b = q('[data-del-key]')) { const e = elById(b.dataset.delKey); setKeys(e, elKeys(e).filter((_, i) => i !== +b.dataset.i)); renderPane(); return changed(); }
```

The existing `[data-undo]` branch already removes `<id>.@keys`.

- [ ] **Step 8: Check it in the browser.** On `localhost:4321`, select `s2-tagline` and add keyframes at 12.0s (as is) and 14.0s (moved to x 5):

```bash
E "(() => { localStorage.clear(); return 1; })()"; chrome-devtools-axi open http://localhost:4321
E "(() => { const e = elById('s2-tagline'); setMode('edit'); selectEl(e.id); addKey(e, e.box, 12); addKey(e, [5, 44, 60, 12], 14); renderAll(); return JSON.stringify(elKeys(e)); })()"
E "(() => { seek(13); return 1; })()"; sleep 0.3
E "(() => { return JSON.stringify([elBox(elById('s2-tagline')), document.querySelectorAll('.kf').length, !!document.querySelector('[data-key]')]); })()"
chrome-devtools-axi screenshot $S/keys-panel.png
```

Expected: two keys at 12 and 14; at 13s the box is `[12.5, 44, 60, 12]` (halfway); 2 `.kf` diamonds; keyframe fields present. Read the screenshot: the diamonds sit under S2 on the timeline, the panel shows two keyframe rows, and the selected box on the frame is between the two positions. Then `E "document.querySelector('#sendBtn').click(), document.querySelector('.sheet textarea').value"` contains `keyframes, ease in-out` with `12s [20,44,60,12] -> 14s [5,44,60,12]`. Close the sheet with `chrome-devtools-axi press Escape` (don't click Copy, it marks edits as sent).

- [ ] **Step 9: Regression check on an mp4-only project.** Run `node ~/.claude/skills/motion-os/player/serve.mjs ~/.claude/skills/motion-os/examples/qbot-tag --no-open --port 4400` in the background, open `http://localhost:4400`, run `E "selftest()"` → `selftest ok`, then add 2 keys to the first element with a box and confirm during playback (`E "(() => { play(); return 1; })()"`, wait 1s, screenshot) that the ghost patch moves. Stop the server afterwards.

- [ ] **Step 10: Checkpoint.** Commit only if okayed: `git add player/index.html && git commit -m "player: keyframe timeline row, panel, ghost preview, prompt line and live payload"`.

---

### Task 4: Herdcats live renderer understands keyframes

**Files:**
- Create: `/Users/zhiyaochan/Projects/ios-app/herdcats-launch-video/src/keys.ts`
- Create: `/Users/zhiyaochan/Projects/ios-app/herdcats-launch-video/src/keys.check.ts`
- Modify: `/Users/zhiyaochan/Projects/ios-app/herdcats-launch-video/src/lib.tsx:28-42` (`Boxes`, `BoxesCtx`, `Ed`)
- Modify: `/Users/zhiyaochan/Projects/ios-app/herdcats-launch-video/src/Main.tsx:4,22-26`
- Rebuild: `/Users/zhiyaochan/Projects/ios-app/herdcats-launch-video/motionos-live.js`

**Interfaces:**
- Consumes: the `boxes[id]` shapes from Task 3 (`number[8]` or `{box, keys}`).
- Produces: `Key = {t: number; box: number[]}`, `BoxEdit = number[] | {box: number[]; keys: Key[]}`, `easeInOut(p)`, `keyBox(keys, t)`, `editAt(edit, t): number[] | null` (8 numbers), `SceneFromCtx: React.Context<number>` (scene start frame).

- [ ] **Step 1: Back up (not a git repo).**

```bash
cd /Users/zhiyaochan/Projects/ios-app/herdcats-launch-video && mkdir -p "$S/herdcats-backup" && cp -R src motionos-live.js "$S/herdcats-backup/"
```

- [ ] **Step 2: Write the failing check** `src/keys.check.ts`:

```ts
import {easeInOut, editAt, keyBox} from './keys';

const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
const A = {t: 2, box: [0, 0, 10, 10]}, B = {t: 4, box: [20, 40, 30, 30]};
eq(easeInOut(0.25), 0.0625, 'ease quarter');
eq(keyBox([A], 9), A.box, 'one key holds');
eq(keyBox([A, B], 1), A.box, 'before holds first');
eq(keyBox([A, B], 3), [10, 20, 20, 20], 'midpoint is halfway');
eq(keyBox([A, B], 5), B.box, 'after holds last');
eq(editAt(undefined, 3), null, 'not edited');
eq(editAt([1, 2, 3, 4, 5, 6, 7, 8], 3), [1, 2, 3, 4, 5, 6, 7, 8], 'old shape passes through');
eq(editAt({box: [20, 44, 60, 12], keys: [A, B]}, 3), [20, 44, 60, 12, 10, 20, 20, 20], 'keys become base + box now');
console.log('keys check ok');
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd /Users/zhiyaochan/Projects/ios-app/herdcats-launch-video && npx esbuild src/keys.check.ts --bundle --platform=node --log-level=error | node`
Expected: build error `Could not resolve "./keys"`.

- [ ] **Step 4: Implement** `src/keys.ts`:

```ts
/** Motion OS box edits: a plain move [x, y, w, h, nx, ny, nw, nh], or keyframes {box, keys} with t in absolute video seconds. */
export type Key = {t: number; box: number[]};
export type BoxEdit = number[] | {box: number[]; keys: Key[]};

export const easeInOut = (p: number) => { p = Math.max(0, Math.min(1, p)); return p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2; };

/** Box at time t: held before the first key and after the last, eased in between. */
export const keyBox = (keys: Key[], t: number): number[] => {
  const [a, b] = keys;
  if (!b || t <= a.t) return a.box;
  if (t >= b.t) return b.box;
  const p = easeInOut((t - a.t) / (b.t - a.t));
  return a.box.map((v, i) => v + (b.box[i] - v) * p);
};

/** [x, y, w, h, nx, ny, nw, nh] for time t, or null when the element isn't edited. */
export const editAt = (edit: BoxEdit | undefined, t: number): number[] | null =>
  !edit ? null : Array.isArray(edit) ? edit : [...edit.box, ...keyBox(edit.keys, t)];
```

(No rounding here, unlike the player's display copy, so the motion is smooth.)

- [ ] **Step 5: Run the check to verify it passes**

Run: same command as Step 3. Expected: `keys check ok`.

- [ ] **Step 6: Use it in `Ed`.** In `src/lib.tsx` replace `export type Boxes = Record<string, number[]>;` through the end of `Ed` with:

```tsx
export type Boxes = Record<string, BoxEdit>;
export const BoxesCtx = React.createContext<Boxes>({});
/** First frame of the scene this element is in, so keyframe times (absolute seconds) line up with useCurrentFrame (scene-relative). */
export const SceneFromCtx = React.createContext(0);

/** Applies a Motion OS edit (move + scale, or keyframes) to an element. Untouched when not edited. */
export const Ed: React.FC<{k: string; children: React.ReactNode}> = ({k, children}) => {
  const boxes = React.useContext(BoxesCtx);
  const from = React.useContext(SceneFromCtx);
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const b = editAt(boxes[k], (from + frame) / fps);
  if (!b) return <>{children}</>;
  const [x, y, w, , nx, ny, nw] = b;
  return (
    <AbsoluteFill style={{transform: `translate(${nx - x}%, ${ny - y}%) scale(${nw / w})`, transformOrigin: `${x}% ${y}%`}}>
      {children}
    </AbsoluteFill>
  );
};
```

and add `import {BoxEdit, editAt} from './keys';` to the imports.

In `src/Main.tsx`, change the lib import to `import {Boxes, BoxesCtx, C, SceneFromCtx, sceneT} from './lib';` and wrap the scene:

```tsx
          <SceneFromCtx.Provider value={Math.round(a * reel.fps)}>
            <BoxesCtx.Provider value={scoped}>
              <Comp qr={staticFile('qr.png')} />
            </BoxesCtx.Provider>
          </SceneFromCtx.Provider>
```

- [ ] **Step 7: Type-check and rebuild the live bundle**

```bash
cd /Users/zhiyaochan/Projects/ios-app/herdcats-launch-video && npx tsc --noEmit && \
npx esbuild src/live.tsx --bundle --format=iife --minify --define:process.env.NODE_ENV='"production"' --outfile=motionos-live.js --log-level=warning && ls -l motionos-live.js
```

Expected: no type errors; a fresh `motionos-live.js` of similar size to the backup. Reload `localhost:4321`; the video still plays and `E "selftest()"` → `selftest ok`.

- [ ] **Step 8: Checkpoint.** Herdcats has no git; the backup in `$S/herdcats-backup` is the rollback.

---

### Task 5: SKILL.md and end-to-end check with Export

**Files:**
- Modify: `SKILL.md` (section 4 "Live projects", section 6 "Apply feedback")

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Document the new `boxes` shape.** In SKILL.md section "Live projects", replace the first bullet (`Wrap each element with a box in a small Ed component ...`) with:

```markdown
- Wrap each element with a `box` in a small `Ed` component. The `boxes` prop maps element id to one of:
  - `[x, y, w, h, nx, ny, nw, nh]`: a move (reel.json box, then the edited box, % of frame).
  - `{"box": [x, y, w, h], "keys": [{"t": 12.0, "box": [nx, ny, nw, nh]}, ...]}`: keyframes, `t` in absolute video seconds. Hold the first box before the first key and the last after the last; ease in-out (`p < .5 ? 4p³ : 1 - (-2p + 2)³ / 2`) between.

  Work out `[nx, ny, nw, nh]` for the current frame, then apply `translate(nx-x %, ny-y %) scale(nw/w)` with `transform-origin: x% y%`. `useCurrentFrame()` is relative to the scene's `<Sequence>`, so give `Ed` the scene's start frame (a context set where the Sequence is mounted) and use `t = (sceneFrom + frame) / fps`. No edit means render children untouched.
```

- [ ] **Step 2: Document applying keyframe feedback.** In section 6, after the "Size and position" bullet, add:

```markdown
- **Keyframes** come as `keyframes, ease in-out ... : 12s [x, y, w, h] -> 14s [x, y, w, h]`. Animate that element's position and scale between the two times with ease in-out, holding before and after, on top of its existing motion. Set its `box` in `reel.json` to the first keyframe's box. Once the new version loads, the player drops the sent keyframes, so the motion now lives only in the code.
```

- [ ] **Step 3: Read SKILL.md back** and check the two edits read cleanly and nothing else changed: `git -C /Users/zhiyaochan/Projects/skills/motion-os diff SKILL.md`.

- [ ] **Step 4: End-to-end with Export.** With the S2 tagline keyframes from Task 3 Step 8 in place on `localhost:4321` (`12s [20,44,60,12] -> 14s [5,44,60,12]`):

```bash
E "(() => { document.querySelector('#exportBtn').click(); return 1; })()"
# poll until done
until curl -s localhost:4321/export | grep -q '"state":"done"\|"state":"error"'; do sleep 5; done; curl -s localhost:4321/export
cd /Users/zhiyaochan/Projects/ios-app/herdcats-launch-video && OUT=$(ls -t exports/*.mp4 | head -1)
for t in 11.5 13 14.5; do ffmpeg -v error -y -ss $t -i "$OUT" -frames:v 1 "$S/kf-$t.jpg"; done
ffmpeg -v error -y -ss 13 -i video.mp4 -frames:v 1 "$S/orig-13.jpg"
```

Expected: export state `done`. Read the frames: at 11.5s the tagline is where the original video has it (held at the first key), at 14.5s it is shifted left by 15% of the frame (≈288px), and at 13s it is halfway (≈144px left of `orig-13.jpg`). This is the Review Focus #5 check: S2 starts at 11s, so a scene-offset bug would put the motion at 23–25s instead.

- [ ] **Step 5: Clean up** the test keyframes in the headless browser (`E "(() => { localStorage.clear(); return 1; })()"`) and delete the test export file from `exports/` (it was made for this check only).

- [ ] **Step 6: Checkpoint.** Commit only if okayed: `git add SKILL.md docs && git commit -m "skill: document keyframes in boxes and how to apply keyframe feedback"`.
