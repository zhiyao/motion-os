# Keyframes as reel.json Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An element's `keys` in reel.json become its keyframes in the player (◆, Keyframes section, moving box, editable), live renderers animate them from data, and agents record applied keyframes there.

**Architecture:** `elKeys` falls back to `e.keys`; `setKeys` stores an override only when it differs from `e.keys` (an explicit `[]` means "remove the animation"). The live payload only carries overridden keys; `Ed` reads reel keys itself. The poll row's `from` shows the reel keys.

**Tech Stack:** Node built-ins; single-file player; `chrome-devtools-axi`.

**Spec:** `docs/specs/2026-10-09-reel-keyframes-design.md`

## Global Constraints

- `keys`: `[{t, box}]`, 1–2 entries, sorted, `t` render-time seconds; keyframe boxes may extend past 0–100.
- Override equal to `e.keys` → removed; `[]` with `e.keys` → stored (removal); `[]` without `e.keys` → removed.
- `liveBoxes`: only overridden keys are sent (`{box, keys}`; `keys: []` = static).
- Poll row for a removal: `to: none (remove the animation)`.
- Herdcats is out of scope (another session migrates it). Don't poll or send on it.
- Commit only after asking.

## Review Focus

1. An element with reel keys and no override: K/drag must edit the reel animation (override starts from the reel keys), not start a fresh one. (Task 2 Step 1: drag on a reel keyframe.)
2. Explicit removal must be undoable from the card. (Task 2 Step 1: "Animation removed" row has Undo.)
3. After a new version, the element shows the new reel keys, not nothing. (Task 2 Step 1.)
4. mp4 ghost for an edited reel animation copies from where the mp4 shows the element (the reel-keyed box), not the resting box. (Task 3 Step 3 browser check.)
5. `check` must accept push-in boxes that leave the frame. (Task 1 Step 1.)

---

### Task 1: `check` validates `keys`

**Files:** `bin/check.mjs` (element loop, line ~17), `bin/selftest.mjs` (check section).

- [ ] **Step 1: Failing tests** — append to the check section of `selftest()`:

```js
  r = good(); r.scenes[0].els[0].keys = [{t: 1, box: [10, 10, 50, 50]}, {t: 3, box: [0, -40, 80, 140]}]; eq(msgs(r), [], 'valid keys (boxes may leave the frame)');
  r = good(); r.scenes[0].els[0].keys = [{t: 3, box: [10, 10, 50, 50]}, {t: 1, box: [10, 10, 50, 50]}]; eq(msgs(r), ['error a: keys are not in time order'], 'unsorted keys');
  r = good(); r.scenes[0].els[0].keys = [1, 2, 3]; eq(msgs(r), ['error a: keys must be 1 or 2 {t, box: [x, y, w, h]} entries'], 'bad keys');
  r = good(); r.scenes[0].els[0].keys = [{t: 9, box: [10, 10, 50, 50]}]; eq(msgs(r), ['error a: a keyframe is outside its time 0-4s'], 'key outside the element time');
```

- [ ] **Step 2: Run** `node bin/motion-os-axi.mjs --selftest` → `FAIL ... unsorted keys` (valid keys pass already since nothing checks them).

- [ ] **Step 3: Implement** — in `checkReelData`'s element loop, after the `e.t` check:

```js
      if (e.keys != null) {
        const k = e.keys, ok = Array.isArray(k) && k.length >= 1 && k.length <= 2 && k.every(x => typeof x?.t === 'number' && Array.isArray(x.box) && x.box.length === 4 && x.box.every(n => typeof n === 'number'));
        if (!ok) err(e.id, 'keys must be 1 or 2 {t, box: [x, y, w, h]} entries');
        else {
          if (k[1] && k[1].t <= k[0].t) err(e.id, 'keys are not in time order');
          if (Array.isArray(e.t) && k.some(x => x.t < e.t[0] - tol || x.t > e.t[1] + tol)) err(e.id, `a keyframe is outside its time ${e.t[0]}-${e.t[1]}s`);
        }
      }
```

- [ ] **Step 4: Run** → `selftest ok`. **Step 5: Checkpoint.**

---

### Task 2: Player treats reel keys as the element's keyframes

**Files:** `player/index.html` — `elKeys` (~453), `liveBoxes` (~531), `drawGhosts` (~593), `keysHTML` (~769) and `elCard`, `setKeys` (~835), `editRow` `@keys` branch (~1025), `selftest()`.

**Interfaces:** Produces `keysStr(keys): string`; `elKeys(e)` semantics above.

- [ ] **Step 1: Failing tests** — in `selftest()`, right after the line ending `'old payload for plain moves');`, add:

```js
    // keyframes from reel.json
    const rs = P.scenes.find(s => s.els.some(x => x.box && x.t[1] - x.t[0] > 1.5)), re = rs.els.find(x => x.box && x.t[1] - x.t[0] > 1.5);
    const RK = [{t: fps1(re.t[0] + 0.2), box: re.box}, {t: fps1(re.t[0] + 1.2), box: [re.box[0], re.box[1] - 10, re.box[2] * 1.2, re.box[3] * 1.2].map(v => Math.round(v * 10) / 10)}];
    re.keys = RK; st.over = {}; const RE = () => elById(re.id);
    try {
      eq(elKeys(RE()), RK, "reel keys are the element's keyframes");
      vid.currentTime = (RK[0].t + RK[1].t) / 2; eq(elBox(RE()), keyBox(RK, now()), 'box follows the reel keys');
      Object.assign(ui, {sel: re.id, scene: rs.id, tab: 'scene'}); renderTL(); renderPane();
      eq([document.querySelectorAll('#tl .kf').length, !!document.querySelector(`[data-key="${re.id}"]`), document.querySelector(`[data-undo="${re.id}.@keys"]`)?.closest('.f')?.classList.contains('changed')], [2, true, false], 'diamonds and an unchanged Keyframes section');
      eq(liveBoxes()[re.id], undefined, 'nothing sent to the renderer without an edit');
      vid.currentTime = RK[1].t; moveTo(RE(), [5, 5, re.box[2], re.box[3]]);
      eq(st.over[`${re.id}.@keys`]?.[1].box, [5, 5, re.box[2], re.box[3]], 'dragging on a reel keyframe makes an edit');
      eq(editRow(`${re.id}.@keys`, st.over[`${re.id}.@keys`]).from, `${+RK[0].t.toFixed(2)}s [${RK[0].box.join(' ')}] -> ${+RK[1].t.toFixed(2)}s [${RK[1].box.join(' ')}]`, 'poll row from is the reel keys');
      setKeys(RE(), RK); eq(`${re.id}.@keys` in st.over, false, 'setting the reel keys back removes the edit');
      setKeys(RE(), []); eq([st.over[`${re.id}.@keys`], elKeys(RE()), elBox(RE())], [[], null, re.box], 'deleting both stores an explicit removal');
      renderPane(); eq(!!document.querySelector(`.f.changed [data-undo="${re.id}.@keys"]`), true, 'a removal can be undone from the card');
      eq([liveBoxes()[re.id], editRow(`${re.id}.@keys`, []).to], [{box: re.box, keys: []}, 'none (remove the animation)'], 'removal goes to the renderer and the agent');
      eq(keepAfterNewVersion({[`${re.id}.@keys`]: []}, {[`${re.id}.@keys`]: []}), {}, 'a sent keyframe edit is dropped on the new version');
      st.over = {}; eq(elKeys(RE()), RK, 'after the drop the reel keys show again');
    } finally { delete re.keys; }
```

- [ ] **Step 2: Run** on qbot (`node bin/motion-os-axi.mjs open examples/qbot-tag --no-open` with a temp `MOTION_OS_AXI_HOME`, open the URL, run `selftest()`) → `FAIL reel keys are the element's keyframes`.

- [ ] **Step 3: Implement.**

`elKeys`:

```js
// An element's keyframes: the player's edit if any (an empty edit means "no animation"), else reel.json's `keys`.
const elKeys = e => { const k = get(`${e.id}.@keys`, e.keys || null); return k && k.length ? k : null; };
```

`setKeys`:

```js
function setKeys(e, keys){
  delete st.over[`${e.id}.@box`];
  const sorted = [...keys].sort((a, b) => a.t - b.t), base = e.keys || null;
  if (base ? JSON.stringify(sorted) === JSON.stringify(base) : !sorted.length) delete st.over[`${e.id}.@keys`];   // same as reel.json, or nothing to say
  else st.over[`${e.id}.@keys`] = sorted;                                                                        // includes [] = remove the reel animation
  touchScene(e.s); markDirty();
}
```

`liveBoxes`: replace `const k = elKeys(e), m = ...` line with

```js
    const k = `${e.id}.@keys` in st.over ? st.over[`${e.id}.@keys`] : null, m = get(`${e.id}.@box`, null);   // reel keys: Ed reads them itself
```

`drawGhosts`: replace `o = e.box` in `const [was, cv] = g.children, o = e.box, ...` with `o = e.keys?.length ? keyBox(e.keys, now()) : e.box` (where the mp4 shows the element).

`editRow`: replace the `@keys` branch with

```js
  if (k === '@keys') { const from = e.keys?.length ? keysStr(e.keys) : boxStr(e.box);
    if (!v.length) return {...row, field: 'keyframes', from, to: 'none (remove the animation)'};
    return v.length === 1 && !e.keys?.length ? {...row, t: v[0].t, field: 'size+position', from: boxStr(e.box), to: boxStr(v[0].box)}
      : {...row, t: v[0].t, field: 'keyframes', from, to: keysStr(v) + ' (ease in-out)'}; }
```

and add next to `boxStr`: `const keysStr = ks => ks.map(x => `${+x.t.toFixed(2)}s ${boxStr(x.box)}`).join(' -> ');`

`keysHTML`: change the opening `<div class="f changed">` to ``<div class="f ${`${e.id}.@keys` in st.over ? 'changed' : ''}">``.

`elCard`: replace `${elKeys(e) ? keysHTML(e) : boxHTML(e)}` with

```js
${elKeys(e) ? keysHTML(e) : (`${e.id}.@keys` in st.over ? `<div class="f changed"><div class="fl">Animation removed<span class="sp"></span><button class="undo" data-undo="${e.id}.@keys">Undo</button></div></div>` : '') + boxHTML(e)}
```

- [ ] **Step 4: Run** → `selftest ok` on qbot. **Step 5: Checkpoint.**

---

### Task 3: SKILL.md and a browser check with reel keys

**Files:** `SKILL.md`.

- [ ] **Step 1: SKILL.md.**
- In section 4's rules, after the "An element is anything a viewer might want to change" bullet, add: ``- An element whose position/size animates gets `keys`: `[{"t": 5.4, "box": [x, y, w, h]}, {"t": 7.8, "box": [...]}]` (render-time seconds, 1 or 2, ease in-out between, held before and after). `box` stays its resting box. The player shows and edits these as keyframes.``
- In "Live projects", in the `Ed` bullet, after "`{"box": ..., "keys": [...]}`: keyframes" sub-bullet add a sub-bullet: ``- no entry: the element's `keys` from reel.json, if any. An entry replaces them (`keys: []` = no animation). Don't also animate that element's box in scene code, or the motion is applied twice.``
- Replace the "**Keyframes** come as an edit row ..." bullet in section 6 with: ``- **Keyframes** come as an edit row with field `keyframes`: `from` is the current keys, `to` like `12s [x y w h] -> 14s [x y w h] (ease in-out)` or `none (remove the animation)`. Live projects: set (or remove) the element's `keys` in reel.json; `Ed` animates them, no motion code. mp4 projects: implement the motion in code and record the same `keys` in reel.json. Keep `box` as the resting box.``

- [ ] **Step 2: Read back** `git diff SKILL.md`.

- [ ] **Step 3: Browser check.** Copy qbot-tag to a temp project, give one element `keys`, and open it:

```bash
T=$(mktemp -d)/qbot && cp -R examples/qbot-tag $T && rm -rf $T/.motion-os-axi
python3 - "$T/reel.json" <<'PY'
import json,sys; p=sys.argv[1]; r=json.load(open(p)); e=next(e for s in r['scenes'] for e in s['els'] if e.get('box') and e['t'][1]-e['t'][0]>3)
b=e['box']; e['keys']=[{'t':round(e['t'][0]+0.5,2),'box':b},{'t':round(e['t'][0]+2.5,2),'box':[b[0]-10,b[1]-5,round(b[2]*1.2,1),round(b[3]*1.2,1)]}]
json.dump(r,open(p,'w'),indent=1); print(e['id'], e['keys'])
PY
node bin/motion-os-axi.mjs check $T | sed -n 2,3p          # problems: 0
U=$(node bin/motion-os-axi.mjs open $T --no-open | grep -o 'http://[^"]*')
```

Open `$U`, select that element in Edit, seek between its keys, screenshot: two ◆ under its scene, the Keyframes section without the changed highlight, the selection box between the two key boxes. Drag one keyframe (`moveTo` on a key time), play, screenshot: the ghost patch moves and its "was" outline follows the reel-keyed box (Review Focus 4). Then stop the player and delete `$T`.

- [ ] **Step 4: Regression:** `node bin/motion-os-axi.mjs --selftest`, `node player/serve.mjs --selftest`, player `selftest()` on qbot-tag.

- [ ] **Step 5: Checkpoint.** Ask before committing.
