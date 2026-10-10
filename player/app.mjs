import { createConversationRenderer, truncatePreview as cut } from './conversation.mjs';
import { loadState, saveState } from './state.mjs';
import { liveVideo } from './playback.mjs';
import {
  clamp,
  keyBox,
  indexProject,
  pathExists as modelPathExists,
  pendingOverrides,
  createTimeline,
} from './model.mjs';

/* ================= project: everything comes from reel.json next to this page ================= */
const FONTS = [
  'Bricolage Grotesque',
  'Inter Tight',
  'Instrument Serif',
  'Space Grotesk',
  'DM Sans',
  'Inter',
  'Geist',
];
const TIPS = {
  proj: 'The project file (reel.json) Claude wrote when it built this video. Every text, timing and asset in the panel comes from it.',
  scene: 'The pieces on screen in this scene. Click one here or in the frame to edit it.',
  status: 'Approved scenes are left alone when Claude makes the next version.',
  motion:
    'How it moves. Only the agent can change this, so it goes to the agent when you press Send to Agent.',
  box: 'Where it sits and how big, in % of the frame. In Edit mode you can drag it on the frame instead.',
  timing: 'When it appears and leaves, in seconds.',
  script: 'Every word in the video, in order. The fastest way to fix copy.',
  colors: 'Change a color once and every element using it updates.',
  fonts: 'Headline and body typefaces for the whole video.',
  assets:
    'Images, video and sound used in the video. Add your own here, then swap them into any scene.',
  add: 'Drop new files into the assets/ folder next to reel.json, then say in a note where they go. Links are passed to Claude to download.',
  music: 'Background track. Claude lines the beat drop up with the scene you pick.',
  notes:
    "Notes pin to an exact moment and spot. Use them for things a text box can't change, like motion or pacing.",
  keys: 'Where it is at two moments. It glides between them with ease in-out. In Edit, press K to add one at the playhead.',
  trim: 'This scene is cut short: it plays as before but stops sooner, and every later scene moves earlier. Drag its end on the timeline to change it.',
  pending: 'These reach the video when you press Send to Agent and the agent re-renders it.',
};

/* ================= state ================= */
const $ = (s) => document.querySelector(s);
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
function isDarkTheme() {
  return (
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && systemTheme.matches)
  );
}
function renderThemeToggle() {
  $('#themeBtn').setAttribute('aria-checked', String(!isDarkTheme()));
  $('.theme-toggle-track').dataset.on = String(!isDarkTheme());
  $('#themeBtn').title = isDarkTheme() ? 'Switch to light mode' : 'Switch to dark mode';
}
$('#themeBtn').addEventListener('click', () => {
  const theme = isDarkTheme() ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('motion-os-axi-theme', theme);
  } catch (e) {}
  renderThemeToggle();
});
systemTheme.addEventListener('change', renderThemeToggle);
renderThemeToggle();
const escapeHtml = (s) =>
  String(s ?? '').replace(
    /[&<>"]/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
      })[c],
  );
const ease = (p) => 1 - Math.pow(1 - clamp(p), 3);
const formatTime = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
};
let video = $('#vid');
const overlay = $('#overlay');
let project;
let editorState;
let projectIndex;
let timeline;
let ui = {
  tab: 'scene',
  scene: null,
  sel: null,
  mode: 'preview',
  pop: null,
  selNote: null,
  loop: false,
  hover: null,
};
const clock = {
  rate: 1,
};
let music = null; // <audio> for an uploaded music track

// Edits and notes live in this browser, per project. When a new version loads, what was already sent is cleared.
// Does an edit path still point at something in this reel? A new version can remove elements, scenes or brand entries.
const pathExists = (k) => modelPathExists(project, projectIndex, k);
function pruneMissing() {
  for (const k of Object.keys(editorState.over)) {
    if (!pathExists(k)) {
      delete editorState.over[k];
    }
  }
  editorState.notes.forEach((n) => {
    if (n.el && !elementById(n.el)) {
      n.el = null;
    }
  });
}
// A move on an element animated by reel.json keys only applies while that animation is removed. A move left over from before
// the element got its keys is unsent work (sent moves were already dropped by keepAfterNewVersion), so keep it and make the
// removal explicit: the queue shows "remove the animation" + the move, and Undo brings the new animation back.
function pruneReelBoxes() {
  for (const e of allElements()) {
    if (
      e.keys?.length &&
      `${e.id}.@box` in editorState.over &&
      !(`${e.id}.@keys` in editorState.over)
    ) {
      editorState.over[`${e.id}.@keys`] = [];
    }
  }
}
// Edits to keep when a new version loads: anything not yet sent as-is. That includes a keyframe edit revised after it was
// sent: an @keys edit replaces the element's reel.json keys (Ed never adds it on top), so keeping it can't double the motion.
function loadProject() {
  projectIndex = indexProject(project);
  timeline = createTimeline(project, get);
  const ver = project.version || 1;
  editorState = loadState(project, localStorage);
  pruneReelBoxes();
  pruneMissing();
  project.scenes.forEach((s) => (editorState.status[s.id] ??= 'review'));
  ui = {
    ...ui,
    scene: project.scenes[0].id,
    sel: null,
    pop: null,
    selNote: null,
  };
  $('#projTitle').textContent = project.title;
  $('#projVer').textContent = 'v' + ver;
  document.title = project.title + ' · Motion OS AXI';
  video.src = project.src + '?v=' + ver;
  video.currentTime = 0.7;
  setupMusic();
  markDirty();
  renderAll();
  tick();
}

/* overrides: every edit is a path -> value */
const get = (path, base) => (path in editorState.over ? editorState.over[path] : base);
const set = (path, v, base) => {
  if (JSON.stringify(v) === JSON.stringify(base)) {
    delete editorState.over[path];
  } else {
    editorState.over[path] = v;
  }
  markDirty();
};
const sceneById = (id) => projectIndex.sceneOf(id);
const allElements = () => projectIndex.allEls();
const elementById = (id) => projectIndex.elById(id);
const propertyValue = (e, k) => get(`${e.id}.${k}`, e.props[k].v);
const elementTime = (e) => get(`${e.id}.@time`, e.t);
const snapToFrame = (t) => Math.round(t * project.fps) / project.fps;
// An element's keyframes: the player's edit if any (an empty edit means "no animation"), else reel.json's `keys`.
const elementKeys = (e) => {
  const k = get(`${e.id}.@keys`, e.keys || null);
  return k && k.length ? k : null;
};
const elementBox = (e) => {
  const k = elementKeys(e);
  return k ? keyBox(k, now()) : get(`${e.id}.@box`, e.box);
};
const brandColor = (id) => {
  const c = project.brand.colors.find((c) => c.id === id);
  return c ? get('brand.color.' + id, c.v) : id;
};
const color = (v) => (typeof v === 'string' && v.startsWith('brand.') ? brandColor(v.slice(6)) : v);
const brandFont = (id) => get('brand.font.' + id, project.brand.fonts.find((f) => f.id === id)?.v);
const assetSrc = (id) =>
  id === 'brand.logo' ? assetSrc(get('brand.logo', project.brand.logo)) : id || null;
const assetName = (id) => {
  if (id === 'brand.logo') {
    return 'Brand logo';
  }
  const a = project.assets.find((a) => a.id === id);
  return a?.name || id;
};
const elEdited = (e) => Object.keys(editorState.over).some((k) => k.startsWith(e.id + '.'));
const sceneAt = (t) => timeline.sceneAt(t);
const now = () => video.currentTime;
/* trims: "<sid>.@len" shortens a scene by cutting its tail; later scenes move earlier. Stored times stay in render time
   (the current video's clock); edited time is what you watch with cut tails removed. */
const sceneLen = (...args) => timeline.sceneLen(...args);
const sceneLayout = (...args) => timeline.sceneLayout(...args);
const editedDuration = (...args) => timeline.edDur(...args);
const sceneEnd = (...args) => timeline.sceneEnd(...args);
const isCut = (...args) => timeline.isCut(...args);
const toEditedTime = (...args) => timeline.toEd(...args);
const toRenderTime = (...args) => timeline.toSrc(...args);
const nextAfterCut = (...args) => timeline.nextAfterCut(...args);
const openNotes = () => editorState.notes.filter((n) => !editorState.sent.includes(n.id));
const queueCount = () => pendingEdits() + openNotes().length + (editorState.messages?.length || 0);
// Counts what Send would actually send: edits that still point at something, and trims that really shorten a scene.
const pendingOver = () =>
  pendingOverrides(editorState.over, editorState.sentSnap, pathExists, realTrim);
const pendingEdits = () => pendingOver().length + editorState.links.filter((l) => !l.sent).length;
function markDirty() {
  if (!project) {
    return;
  }
  saveState(project, editorState, localStorage);
  $('#convoN').textContent = queueCount();
}

/* ================= playback ================= */
function play() {
  if (ui.mode === 'edit') {
    setMode('preview');
  }
  video.play();
  syncMusic(true);
  closePop();
  setPlayIcon(true);
}
function pause() {
  if (!project) {
    return;
  }
  video.pause();
  syncMusic(false);
  setPlayIcon(false);
}
const playing = () => !video.paused;
function setPlayIcon(on) {
  $('#playIco').innerHTML = on
    ? '<path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/>'
    : '<path d="M4 2.5v11l9-5.5z" fill="currentColor"/>';
}
function seek(t) {
  t = clamp(t, 0, project.duration - 0.02);
  if (isCut(t)) {
    t = sceneEnd(sceneAt(t)) - 1 / project.fps;
  }
  t = Math.min(t, sceneEnd(project.scenes[project.scenes.length - 1]) - 0.02); // a trimmed last scene's end is past the last frame
  video.currentTime = t;
  syncMusic(playing());
  const s = sceneAt(t).id;
  if (s !== ui.scene) {
    ui.scene = s;
    if (ui.sel && elementById(ui.sel)?.s !== s) {
      ui.sel = null;
    }
    renderTL();
    if (ui.tab === 'scene') {
      renderPane();
    }
  }
  tick();
}
const loopEnd = (s) => sceneEnd(s);
function vframe() {
  if (!video.paused) {
    if (ui.loop) {
      const s = sceneById(ui.scene);
      if (video.currentTime >= loopEnd(s) - 0.03) {
        video.currentTime = s.t[0];
      }
    } else if (!live) {
      const j = nextAfterCut(video.currentTime);
      if (j === -1) {
        video.currentTime = sceneEnd(sceneAt(video.currentTime)) - 1 / project.fps;
        pause();
      } else if (j != null) {
        video.currentTime = j;
      }
    }
    tick();
    requestAnimationFrame(vframe);
  }
}
function wireVideo() {
  video.addEventListener('play', () => {
    setPlayIcon(true);
    vframe();
  });
  video.addEventListener('pause', () => {
    setPlayIcon(false);
    tick();
  });
  video.addEventListener('seeked', tick);
  video.addEventListener('loadedmetadata', () => {
    if (video.currentTime < 0.1) {
      video.currentTime = 0.7;
    }
    tick();
  });
  video.addEventListener('ended', () => setPlayIcon(false));
}
// Live projects ("live": "bundle.js" in reel.json) render the real composition in the page instead of the mp4,
// so size and position edits show for real. This wraps it in the few <video> calls the player uses.
let live = null;
let sentBoxes = '';
let sentScenes = '{}';
const sceneLens = () =>
  Object.fromEntries(
    project.scenes
      .filter((s) => `${s.id}.@len` in editorState.over)
      .map((s) => [s.id, sceneLen(s)]),
  );
function liveBoxes() {
  // edited boxes the composition needs: id -> [base box, new box], or {box: base, keys} when keyframed
  const b = {};
  for (const e of allElements()) {
    if (!e.box) {
      continue;
    }
    const k = `${e.id}.@keys` in editorState.over ? editorState.over[`${e.id}.@keys`] : null;
    const m = get(`${e.id}.@box`, null); // reel keys: Ed reads them itself
    // a removed reel animation plus a move holds the element at the moved box; a move never overrides reel keys on its own
    if (k) {
      b[e.id] = {
        box: e.box,
        keys: k.length
          ? k
          : m
            ? [
                {
                  t: 0,
                  box: m,
                },
              ]
            : [],
      };
    } else if (m && !e.keys?.length) {
      b[e.id] = [...e.box, ...m];
    }
  }
  return b;
}
function tick() {
  const t = now();
  const s = sceneAt(t);
  if (s.id !== ui.scene && playing() && !ui.loop) {
    ui.scene = s.id;
    if (ui.sel && elementById(ui.sel)?.s !== s.id) {
      ui.sel = null;
    }
    renderTL();
    if (ui.tab === 'scene') {
      renderPane();
    }
  }
  $('#tc').innerHTML =
    `${formatTime(toEditedTime(t))} <small>/ ${formatTime(editedDuration())} · ${s.id} ${escapeHtml(s.name)}</small>`;
  placePH();
  renderHots();
}
function setupMusic() {
  if (music) {
    music.pause();
    music = null;
  }
  const id = get('audio.music', project.audio.music);
  const src = id && assetSrc(id);
  if (src) {
    music = new Audio(src);
    music.volume = get('audio.musicVol', project.audio.musicVol);
  }
}
function syncMusic(on) {
  if (!music) {
    return;
  }
  if (on) {
    music.currentTime = toEditedTime(now());
    music.playbackRate = clock.rate;
    music.play().catch(() => {});
  } else {
    music.pause();
  }
}
new ResizeObserver(() => {
  placePH();
  renderHots();
}).observe($('#viewer'));

/* ================= frame overlay: select + pins ================= */
function boxOf(e) {
  const t = now();
  const [a, b] = elementTime(e);
  if (t < a || t > b) {
    return null;
  }
  return elementBox(e);
}
function hit(x, y) {
  return sceneById(ui.scene)
    .els.map((e) => ({
      e,
      b: boxOf({
        ...e,
        s: ui.scene,
      }),
    }))
    .filter(
      (o) => o.b && x >= o.b[0] && x <= o.b[0] + o.b[2] && y >= o.b[1] && y <= o.b[1] + o.b[3],
    )
    .sort((p, q) => p.b[2] * p.b[3] - q.b[2] * q.b[3])[0]?.e;
}
function renderHots() {
  const t = now();
  const out = [];
  const ids =
    ui.mode === 'edit'
      ? [
          ui.sel,
          ...sceneById(ui.scene)
            .els.filter((e) => e.box && e.id !== ui.sel)
            .map((e) => e.id),
        ]
      : [ui.sel, ui.hover];
  for (const id of ids) {
    if (!id || (id === ui.hover && id === ui.sel && out.length)) {
      continue;
    }
    const e = elementById(id);
    if (!e || e.s !== ui.scene) {
      continue;
    }
    const b = boxOf(e);
    if (!b) {
      continue;
    }
    const mv = id === ui.sel && ui.mode === 'edit';
    const sc = e.box && Math.round((b[2] / e.box[2]) * 100);
    out.push(
      `<div class="hot ${id === ui.sel ? '' : ui.mode === 'edit' && id !== ui.hover ? 'can' : 'hover'} ${b[1] < 8 ? 'in' : ''} ${mv ? 'mv' : ''}" style="left:${b[0]}%;top:${b[1]}%;width:${b[2]}%;height:${b[3]}%">${id === ui.sel ? `<span>${escapeHtml(e.label)}</span>` : ''}${mv ? ['nw', 'ne', 'sw', 'se'].map((h) => `<i class="hd" data-h="${h}"></i>`).join('') + (sc !== 100 ? `<em>${sc}%</em>` : '') : ''}</div>`,
    );
  }
  editorState.notes.forEach((n, i) =>
    out.push(
      `<div class="pin ${Math.abs(n.t - t) > 0.9 || editorState.sent.includes(n.id) ? 'dim' : ''}" data-pin="${n.id}" style="left:${n.x}%;top:${n.y}%">${i + 1}</div>`,
    ),
  );
  if (ui.mode === 'note') {
    out.push(`<div class="chip left"><i></i>Click to add a note</div>`);
  } else if (ui.mode === 'edit') {
    out.push(
      `<div class="chip left"><i style="background:var(--accent)"></i>Edit: drag to move, corners to resize · saves automatically</div>`,
    );
  } else if (pendingEdits()) {
    out.push(
      `<div class="chip">${pendingEdits()} edit${pendingEdits() === 1 ? '' : 's'} waiting <button class="info" data-tip-id="pending">i</button></div>`,
    );
  }
  $('#hots').innerHTML = out.join('');
  drawGhosts();
}
// Moved or resized elements: blur where it was, and draw that patch of the video at the new spot as a live preview.
function drawGhosts() {
  if (live) {
    const j = JSON.stringify(liveBoxes());
    if (j !== sentBoxes) {
      sentBoxes = j;
      live.setBoxes(JSON.parse(j));
    }
    const sj = JSON.stringify(sceneLens());
    if (live.setScenes && sj !== sentScenes) {
      sentScenes = sj;
      live.setScenes(JSON.parse(sj));
    }
    return;
  }
  const layer = $('#ghosts');
  const keep = new Set();
  const r = overlay.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  for (const e of sceneById(ui.scene).els.map((e) => ({
    ...e,
    s: ui.scene,
  }))) {
    if (!e.box || !(`${e.id}.@box` in editorState.over || `${e.id}.@keys` in editorState.over)) {
      continue;
    }
    const b = boxOf(e);
    if (!b) {
      continue;
    }
    keep.add(e.id);
    let g = layer.querySelector(`[data-g="${e.id}"]`);
    if (!g) {
      g = document.createElement('div');
      g.dataset.g = e.id;
      g.innerHTML = '<div class="was"></div><canvas class="ghost"></canvas>';
      layer.appendChild(g);
    }
    const [was, cv] = g.children;
    const o = e.keys?.length ? keyBox(e.keys, now()) : e.box;
    const pos = (el, x) =>
      Object.assign(el.style, {
        left: x[0] + '%',
        top: x[1] + '%',
        width: x[2] + '%',
        height: x[3] + '%',
      });
    pos(was, o);
    pos(cv, b);
    const w = Math.max(1, Math.round((b[2] / 100) * r.width * dpr));
    const h = Math.max(1, Math.round((b[3] / 100) * r.height * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw) {
      cv.getContext('2d').drawImage(
        video,
        (o[0] / 100) * vw,
        (o[1] / 100) * vh,
        (o[2] / 100) * vw,
        (o[3] / 100) * vh,
        0,
        0,
        w,
        h,
      );
    }
  }
  [...layer.children].forEach((g) => keep.has(g.dataset.g) || g.remove());
}
const pt = (ev) => {
  const r = overlay.getBoundingClientRect();
  return [((ev.clientX - r.left) / r.width) * 100, ((ev.clientY - r.top) / r.height) * 100];
};
overlay.addEventListener('mousemove', (ev) => {
  if (ui.mode === 'note' || drag || ev.target.closest('.pop,.chip')) {
    return;
  }
  if (ui.mode === 'preview') {
    if (ui.hover) {
      ui.hover = null;
      renderHots();
    }
    overlay.style.cursor = '';
    return;
  }
  const [x, y] = pt(ev);
  const g = grab(x, y);
  const h = hit(x, y)?.id || null;
  if (h !== ui.hover) {
    ui.hover = h;
    renderHots();
  }
  overlay.style.cursor = g?.h
    ? g.h === 'nw' || g.h === 'se'
      ? 'nwse-resize'
      : 'nesw-resize'
    : g
      ? 'move'
      : h
        ? 'move'
        : '';
});
// What's under the pointer on the selected element: a corner handle (h), or its body.
function grab(x, y) {
  const sel = ui.sel && elementById(ui.sel);
  const sb = sel && sel.s === ui.scene && sel.box && boxOf(sel);
  if (!sb) {
    return null;
  }
  const r = overlay.getBoundingClientRect();
  const near = (cx, cy) => Math.hypot(((x - cx) / 100) * r.width, ((y - cy) / 100) * r.height) < 14;
  const h = [
    ['nw', 0, 0],
    ['ne', 1, 0],
    ['sw', 0, 1],
    ['se', 1, 1],
  ].find(([, i, j]) => near(sb[0] + sb[2] * i, sb[1] + sb[3] * j))?.[0];
  return h || (x >= sb[0] && x <= sb[0] + sb[2] && y >= sb[1] && y <= sb[1] + sb[3])
    ? {
        h,
        sel,
        sb,
      }
    : null;
}
overlay.addEventListener('mouseleave', () => {
  ui.hover = null;
  renderHots();
});
let drag = null;
overlay.addEventListener('pointerdown', (ev) => {
  if (ui.mode !== 'edit' || ev.button || ev.target.closest('.pop,.chip,[data-pin]')) {
    return;
  }
  const [x, y] = pt(ev);
  let g = grab(x, y);
  if (!g) {
    const e = hit(x, y);
    if (!e?.box) {
      if (ui.sel) {
        ui.sel = null;
        renderPane();
        renderTL();
        renderHots();
      }
      return;
    }
    selectEl(e.id, true);
    g = grab(x, y);
    if (!g) {
      return;
    }
  }
  const ks = elementKeys(g.sel);
  if (ks && ks.length >= 2 && onKey(ks, snapToFrame(now())) < 0) {
    toast('Jump to a keyframe to change it');
    return;
  }
  pause();
  drag = {
    h: g.h,
    x,
    y,
    b: [...g.sb],
    e: g.sel,
  };
  overlay.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});
overlay.addEventListener('pointermove', (ev) => {
  if (!drag) {
    return;
  }
  const [x, y] = pt(ev);
  const [bx, by, bw, bh] = drag.b;
  const r1 = (v) => Math.round(v * 10) / 10;
  let nb;
  if (!drag.h) {
    nb = [bx + x - drag.x, by + y - drag.y, bw, bh];
  } else {
    // corners scale uniformly, anchored at the opposite corner (it's a picture of the frame, so no stretching)
    const L = drag.h[1] === 'w';
    const T = drag.h[0] === 'n';
    const ax = L ? bx + bw : bx;
    const ay = T ? by + bh : by;
    const s = Math.max(0.1, ((L ? ax - x : x - ax) / bw + (T ? ay - y : y - ay) / bh) / 2);
    nb = [L ? ax - bw * s : ax, T ? ay - bh * s : ay, bw * s, bh * s];
  }
  moveTo(drag.e, nb.map(r1));
  renderHots();
});
overlay.addEventListener('pointerup', () => {
  if (drag) {
    drag = null;
    renderPane();
    changed();
  }
});
overlay.addEventListener('click', (ev) => {
  if (ev.target.closest('.pop,.chip')) {
    return;
  }
  if (ui.mode === 'edit' && !ev.target.closest('[data-pin]')) {
    return;
  }
  const pin = ev.target.closest('[data-pin]');
  if (pin) {
    return focusNote(+pin.dataset.pin);
  }
  const [x, y] = pt(ev);
  const h = hit(x, y);
  if (ui.mode === 'note' || ev.altKey) {
    pause();
    ui.pop = {
      x,
      y,
      t: now(),
      el: h?.id || null,
    };
    return renderPop();
  }
  if (ui.pop) {
    return closePop();
  }
  playing() ? pause() : play();
});
function renderPop() {
  const p = ui.pop;
  $('#popLayer').innerHTML = p
    ? `<div class="pin" style="left:${p.x}%;top:${p.y}%">${editorState.notes.length + 1}</div>
    <div class="pop" style="left:${Math.min(Math.max(p.x, 2), 68)}%;${p.y > 55 ? `bottom:${100 - p.y + 4}%` : `top:${p.y + 4}%`}">
      <div class="meta mono">${formatTime(toEditedTime(p.t))} · ${sceneAt(p.t).id}${p.el ? ' · ' + escapeHtml(elementById(p.el).label) : ''}</div>
      <textarea id="popTa" placeholder="What should change?"></textarea>
      <div class="row"><button class="btn ghost sm" data-act="cancel">Cancel</button><button class="btn primary sm" data-act="add">Add note</button></div></div>`
    : '';
  if (p) {
    $('#popTa').focus();
  }
}
$('#popLayer').addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-act]');
  if (!a) {
    return;
  }
  if (a.dataset.act === 'cancel') {
    return closePop();
  }
  const text = $('#popTa').value.trim();
  if (!text) {
    return $('#popTa').focus();
  }
  const p = ui.pop;
  const id = Math.max(0, ...editorState.notes.map((n) => n.id)) + 1;
  editorState.notes.push({
    id,
    t: +p.t.toFixed(2),
    x: +p.x.toFixed(1),
    y: +p.y.toFixed(1),
    el: p.el,
    text,
  });
  editorState.notes.sort((a, b) => a.t - b.t);
  const sid = sceneAt(p.t).id;
  if (editorState.status[sid] === 'review') {
    editorState.status[sid] = 'changes';
  }
  ui.pop = null;
  ui.selNote = id;
  renderPop();
  markDirty();
  renderAll();
  toast('Note added');
});
$('#popLayer').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
    $('[data-act="add"]').click();
  }
  if (ev.key === 'Escape') {
    closePop();
  }
});
function closePop() {
  if (ui.pop) {
    ui.pop = null;
    renderPop();
  }
}
function setMode(m) {
  if (m === 'edit') {
    pause();
  }
  ui.mode = m;
  ui.hover = null;
  [...$('#modes').children].forEach((b) =>
    b.classList.toggle('on', b.dataset.m === (m === 'edit' ? 'edit' : 'preview')),
  );
  $('#noteBtn').classList.toggle('on', m === 'note');
  overlay.classList.toggle('note-mode', m === 'note');
  overlay.classList.toggle('move-mode', m === 'edit');
  closePop();
  renderHots();
}

/* ================= timeline ================= */
let trimming = null; // {sid, E, O, D0} while dragging a scene's end; the scale is frozen at D0 so the pointer doesn't chase it
const tlDur = () => (trimming ? trimming.D0 : editedDuration());
const epct = (t) => (t / tlDur()) * 100 + '%'; // edited time -> % of the timeline
const pct = (t) => epct(toEditedTime(t)); // render time -> % of the timeline
// Store a scene's trimmed length, or nothing when it is (to the frame) the full length; reel times like 4.5-9.2 aren't exact floats.
function setTrim(s, L) {
  const O = s.t[1] - s.t[0];
  L = snapToFrame(L);
  if (L >= O - 0.5 / project.fps) {
    delete editorState.over[`${s.id}.@len`];
  } else {
    editorState.over[`${s.id}.@len`] = L;
  }
  markDirty();
}
const realTrim = (k) => {
  const s = sceneById(k.split('.')[0]);
  return !!s && sceneLen(s) < s.t[1] - s.t[0] - 0.5 / project.fps;
};
const canTrim = () => !live || !!live.setScenes;
function renderTL() {
  let beats = '';
  if (project.audio.bpm) {
    const bt = 60 / project.audio.bpm;
    let i = 0;
    for (let t = project.audio.drop % bt; t < editedDuration(); t += bt, i++) {
      const k = Math.round((t - project.audio.drop) / bt);
      beats += `<span class="bt ${Math.abs(t - project.audio.drop) < 0.01 ? 'dropline' : k % 4 === 0 ? 'down' : ''}" style="left:${epct(t)}"></span>`;
    }
  }
  const ke = ui.sel && elementById(ui.sel);
  const keys = ke && elementKeys(ke);
  const keyRow = keys
    ? `<div class="trk keys">${keys.length === 2 ? `<span class="kl" style="left:${pct(keys[0].t)};width:${epct(toEditedTime(keys[1].t) - toEditedTime(keys[0].t))}"></span>` : ''}${keys.map((k) => `<span class="kf" data-key-t="${k.t}" style="left:${pct(k.t)};${isCut(k.t) ? 'opacity:.35;' : ''}" data-tip="${escapeHtml(ke.label)} keyframe at ${formatTime(toEditedTime(k.t))}"></span>`).join('')}</div>`
    : '';
  $('#tl').innerHTML = `
    <div class="trk scenes">${sceneLayout()
      .map(
        ({ s, L, E }) =>
          `<div class="sb ${ui.scene === s.id ? 'on' : ''} ${trimming?.sid === s.id ? 'trimming' : ''}" data-scene="${s.id}" style="left:${epct(E)};width:calc(${epct(L)} - 3px)" ${canTrim() ? '' : 'data-tip="Trimming needs an updated live renderer"'}><b>${escapeHtml(s.name)}</b><small><span class="sd ${editorState.status[s.id]}"></span>${L < s.t[1] - s.t[0] - 1e-6 ? `<span class="cut">${L.toFixed(1)}s</span>` : `${L.toFixed(1)}s`}</small>${canTrim() ? `<i class="trim" data-trim="${s.id}" data-tip="Drag left to shorten this scene"></i>` : ''}</div>`,
      )
      .join('')}</div>
    <div class="trk pins">${editorState.notes.map((n) => `<span class="tp" data-note="${n.id}" style="left:${pct(n.t)};${editorState.sent.includes(n.id) || isCut(n.t) ? 'opacity:.35' : ''}" data-tip="${escapeHtml(n.text)}"></span>`).join('')}</div>
    ${keyRow}
    ${beats ? `<div class="trk beats" data-tip="Beat grid at ${project.audio.bpm} BPM. The blue line is where the music drop lands.">${beats}</div>` : ''}
    <div class="ph" id="ph"></div>`;
  placePH();
}
function placePH() {
  const ph = $('#ph');
  if (ph && project) {
    ph.style.left = `calc(${pct(now())} - 1px)`;
  }
}
let scrubbing = false;
const scrubTo = (ev) => {
  const r = $('#tl .trk').getBoundingClientRect();
  seek(toRenderTime(((ev.clientX - r.left) / r.width) * editedDuration()));
};
$('#tl').addEventListener('pointerdown', (ev) => {
  const tr = ev.target.closest('[data-trim]');
  if (tr) {
    const s = sceneById(tr.dataset.trim);
    const o = sceneLayout().find((o) => o.s === s);
    pause();
    trimming = {
      sid: s.id,
      E: o.E,
      O: s.t[1] - s.t[0],
      D0: editedDuration(),
      t: now(),
    };
    ev.preventDefault();
    return;
  }
  const kf = ev.target.closest('[data-key-t]');
  if (kf) {
    pause();
    return seek(+kf.dataset.keyT);
  }
  const n = ev.target.closest('[data-note]');
  if (n) {
    return focusNote(+n.dataset.note);
  }
  if (!ev.target.closest('.trk')) {
    return;
  }
  scrubbing = true;
  pause();
  scrubTo(ev);
  ev.target.setPointerCapture?.(ev.pointerId);
});
window.addEventListener('pointermove', (ev) => {
  if (trimming) {
    const r = $('#tl .trk').getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * trimming.D0;
    const s = sceneById(trimming.sid);
    setTrim(s, clamp(x - trimming.E, Math.min(0.5, trimming.O), trimming.O));
    renderTL();
    return;
  }
  if (scrubbing) {
    scrubTo(ev);
  }
});
window.addEventListener('pointerup', () => {
  scrubbing = false;
  // seek to where the playhead was in render time: a live clock read now would use the new layout before the player has it
  if (trimming) {
    const { sid, t } = trimming;
    trimming = null;
    touchScene(sid);
    markDirty();
    seek(t);
    renderAll();
  }
});

/* ================= panel ================= */
const ICON = {
  text: '<path d="M3 4h10M8 4v9" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  media:
    '<rect x="2.5" y="3" width="11" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 11l3-3 3 3 2-2 2 2" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  list: '<path d="M3 4h10M3 8h10M3 12h7" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  number:
    '<path d="M5 3l-1 10M11 3l-1 10M3 6h10M2.5 10h10" stroke="currentColor" stroke-width="1.4" fill="none"/>',
};
const elIcon = (e) => {
  const t = Object.values(e.props).map((p) => p.type);
  return ICON[
    t.includes('list')
      ? 'list'
      : t.includes('media')
        ? 'media'
        : e.view === 'counter'
          ? 'number'
          : 'text'
  ];
};
const TABS = [
  ['scene', 'Scene'],
  ['script', 'Script'],
  ['style', 'Style'],
  ['media', 'Media'],
];
function renderTabs() {
  $('#tabs').innerHTML = TABS.map(
    ([k, l]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`,
  ).join('');
}
$('#tabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) {
    ui.tab = b.dataset.tab;
    renderTabs();
    renderPane();
  }
};
function renderPane() {
  $('#pane').innerHTML = {
    scene: scenePane,
    script: scriptPane,
    style: stylePane,
    media: mediaPane,
  }[ui.tab]();
}
function renderAll() {
  renderTabs();
  renderPane();
  renderTL();
  renderHots();
  renderQueue();
}
function scenePane() {
  const s = sceneById(ui.scene);
  const stv = editorState.status[s.id];
  return `<div class="pane">
    <div class="ph2"><h2>${escapeHtml(s.name)}</h2></div>
    ${sceneLen(s) < s.t[1] - s.t[0] - 1e-6 ? `<div class="f changed"><div class="fl">Length ${(s.t[1] - s.t[0]).toFixed(1)}s → ${sceneLen(s).toFixed(1)}s<button class="info" data-tip-id="trim">i</button><span class="sp"></span><button class="undo" data-undo="${s.id}.@len">Undo</button></div></div>` : ''}
    <div class="lbl">On screen <button class="info" data-tip-id="scene">i</button></div>
    ${s.els
      .map((e) =>
        elCard({
          ...e,
          s: s.id,
        }),
      )
      .join('')}
    <div class="scene-approval">
      <div class="status" data-status>${[
        ['review', 'Review'],
        ['changes', 'Fix'],
        ['approved', 'Approved'],
      ]
        .map(
          ([v, l]) =>
            `<button class="${stv === v ? 'on' : ''}" data-v="${v}"><span class="sd ${v}"></span>${l}</button>`,
        )
        .join('')}</div>
      <button class="info" data-tip-id="status">i</button>
    </div>
  </div>`;
}
function elCard(e) {
  return `<div class="el ${ui.sel === e.id ? 'sel' : ''} ${elEdited(e) ? 'edited' : ''}" data-id="${e.id}">
    <button class="elh" data-pick="${e.id}"><span class="ico"><svg viewBox="0 0 16 16">${elIcon(e)}</svg></span><b>${escapeHtml(e.label)}</b><span class="edot"></span><svg class="chev" width="12" height="12" viewBox="0 0 12 12"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>
    ${
      ui.sel === e.id
        ? `<div class="fields">${Object.entries(e.props)
            .map(([k, p]) => fieldHTML(e, k, p))
            .join(
              '',
            )}${elementKeys(e) ? keysHTML(e) : (`${e.id}.@keys` in editorState.over ? `<div class="f changed"><div class="fl">Animation removed<span class="sp"></span><button class="undo" data-undo="${e.id}.@keys">Undo</button></div></div>` : '') + boxHTML(e)}${timingHTML(e)}</div>`
        : ''
    }
  </div>`;
}
function fieldHTML(e, k, p) {
  const path = `${e.id}.${k}`;
  const v = get(path, p.v);
  const ch = path in editorState.over;
  const head = (extra = '') =>
    `<div class="fl">${escapeHtml(p.label)}${extra}<span class="sp"></span><button class="undo" data-undo="${path}">Undo</button></div>`;
  let body = '';
  if (p.type === 'text') {
    body = `<input type="text" data-path="${path}" value="${escapeHtml(v)}">`;
  } else if (p.type === 'longtext') {
    body = `<textarea data-path="${path}" rows="2">${escapeHtml(v)}</textarea>`;
  } else if (p.type === 'number') {
    body = `<input type="number" data-path="${path}" data-num value="${escapeHtml(v)}" ${p.min != null ? `min="${p.min}"` : ''} ${p.max != null ? `max="${p.max}"` : ''}>`;
  } else if (p.type === 'choice') {
    body = `<div class="seg" style="justify-self:start">${p.options.map((o) => `<button data-choice="${path}" data-val="${escapeHtml(o)}" class="${o === v ? 'on' : ''}">${escapeHtml(o)}</button>`).join('')}</div>`;
  } else if (p.type === 'motion') {
    return `<div class="f ${ch ? 'changed' : ''}">${head(` <span class="claude">Claude</span><button class="info" data-tip-id="motion">i</button>`)}<textarea data-path="${path}" rows="2">${escapeHtml(v)}</textarea></div>`;
  } else if (p.type === 'color') {
    body = `<div class="colorf">${project.brand.colors.map((c) => `<button class="sw ${v === 'brand.' + c.id ? 'on' : ''}" style="background:${brandColor(c.id)}" data-color="${path}" data-val="brand.${c.id}" data-tip="${escapeHtml(c.name)}"></button>`).join('')}</div>`;
  } else if (p.type === 'media') {
    body = `<div class="media"><div class="th" style="${thumbStyle(v)}">${thumbLabel(v)}</div><span class="nm">${escapeHtml(assetName(v))}</span><button class="btn sm" data-swap="${path}">Swap</button></div>`;
  } else if (p.type === 'list') {
    body = listHTML(path, p, v);
  }
  return `<div class="f ${ch ? 'changed' : ''}">${head()}${body}</div>`;
}
function listHTML(path, p, rows) {
  const tmpl =
    p.cols
      .map((c) =>
        c.type === 'media'
          ? '30px'
          : c.type === 'choice'
            ? '86px'
            : c.type === 'number'
              ? '70px'
              : '1fr',
      )
      .join(' ') + ' 16px';
  return `<div class="list">${rows
    .map(
      (r, i) =>
        `<div class="lr" style="grid-template-columns:${tmpl}">${p.cols
          .map((c) => {
            const at = `data-list="${path}" data-i="${i}" data-k="${c.k}"`;
            if (c.type === 'media') {
              return `<button class="mth" style="${thumbStyle(r[c.k])}" data-swap="${path}" data-i="${i}" data-k="${c.k}" aria-label="Swap image"></button>`;
            }
            if (c.type === 'choice') {
              return `<select ${at}>${c.options.map((o) => `<option ${o === r[c.k] ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select>`;
            }
            return `<input type="${c.type === 'number' ? 'number' : 'text'}" ${at} value="${escapeHtml(r[c.k])}">`;
          })
          .join(
            '',
          )}<button class="x" data-del-row="${path}" data-i="${i}" aria-label="Remove row">×</button></div>`,
    )
    .join('')}
    <button class="add" data-add-row="${path}">+ Add row</button></div>`;
}
function boxHTML(e) {
  if (!e.box) {
    return '';
  }
  const path = `${e.id}.@box`;
  const b = elementBox(e);
  const ch = path in editorState.over;
  const sc = Math.round((b[2] / e.box[2]) * 100);
  const n = (ix, l, v) =>
    `<label class="fl" style="gap:4px">${l}<input type="number" step="${ix === 's' ? 5 : 0.5}" data-box="${e.id}" data-ix="${ix}" value="${v}"></label>`;
  return `<div class="f ${ch ? 'changed' : ''}"><div class="fl">Size and position<button class="info" data-tip-id="box">i</button><span class="sp"></span><button class="undo" data-undo="${path}">Undo</button></div>
    <div class="row2" style="grid-template-columns:1fr 1fr 1fr">${n('s', 'Scale %', sc)}${n(0, 'X', b[0])}${n(1, 'Y', b[1])}</div></div>`;
}
function keysHTML(e) {
  const keys = elementKeys(e);
  const n = (i, ix, l, v, step) =>
    `<label class="f" style="gap:2px"><span class="fl" style="min-height:0">${i ? '' : l}</span><input type="number" step="${step}" data-key="${e.id}" data-i="${i}" data-ix="${ix}" value="${v}"></label>`;
  return `<div class="f ${`${e.id}.@keys` in editorState.over ? 'changed' : ''}"><div class="fl">Keyframes<button class="info" data-tip-id="keys">i</button><span class="sp"></span><button class="undo" data-undo="${e.id}.@keys">Undo</button></div>
    ${keys.map((k, i) => `<div class="row2" style="grid-template-columns:auto 1.3fr 1fr 1fr 1fr 16px;align-items:end"><button class="kf-go" data-seek="${k.t}" aria-label="Go to keyframe">◆</button>${n(i, 't', 'Time', +toEditedTime(k.t).toFixed(2), +(1 / project.fps).toFixed(4))}${n(i, 0, 'X', k.box[0], 0.5)}${n(i, 1, 'Y', k.box[1], 0.5)}${n(i, 's', 'Scale %', Math.round((k.box[2] / e.box[2]) * 100), 5)}<button class="x" data-del-key="${e.id}" data-i="${i}" aria-label="Delete keyframe">×</button></div>`).join('')}
    ${keys.length < 2 ? `<div class="fl">Go to another moment and press K, or drag it, to add the second keyframe.</div>` : ''}</div>`;
}
function timingHTML(e) {
  const path = `${e.id}.@time`;
  const v = elementTime(e);
  const ch = path in editorState.over;
  return `<div class="f ${ch ? 'changed' : ''}"><div class="fl">Timing<button class="info" data-tip-id="timing">i</button><span class="sp"></span><button class="undo" data-undo="${path}">Undo</button></div>
    <div class="row2"><input type="number" step="0.1" data-time="${e.id}" data-ix="0" value="${Math.round(toEditedTime(v[0]) * 10) / 10}" aria-label="In"><input type="number" step="0.1" data-time="${e.id}" data-ix="1" value="${Math.round(toEditedTime(v[1]) * 10) / 10}" aria-label="Out"></div></div>`;
}
const thumbStyle = (id) => {
  const s = assetSrc(id);
  return s ? `background-image:url('${s}')` : '';
};
const thumbLabel = (id) => (assetSrc(id) ? '' : 'None');
function scriptPane() {
  const groups = project.scenes
    .map((s) => {
      const items = [];
      s.els.forEach((e) =>
        Object.entries(e.props).forEach(([k, p]) => {
          if (p.type === 'text' || p.type === 'longtext') {
            items.push({
              e,
              path: `${e.id}.${k}`,
              base: p.v,
              label: `${e.label}${Object.keys(e.props).length > 2 ? ' · ' + p.label : ''}`,
            });
          }
          if (p.type === 'list') {
            get(`${e.id}.${k}`, p.v).forEach((r, i) =>
              p.cols.forEach((c) => {
                if (c.type === 'text') {
                  items.push({
                    e,
                    list: `${e.id}.${k}`,
                    i,
                    k: c.k,
                    val: r[c.k],
                    label: `${e.label} ${i + 1}${r.from ? ' · ' + r.from : ''}`,
                  });
                }
              }),
            );
          }
        }),
      );
      return `<div class="sgrp"><div class="lbl">${escapeHtml(s.name)}</div>${items.map((it) => (it.list ? `<div class="scr ${it.list in editorState.over ? 'changed' : ''}"><button class="t" data-seek="${elementTime(it.e)[0] + 0.5}">${formatTime(toEditedTime(elementTime(it.e)[0]))} · ${escapeHtml(it.label)}</button><input data-list="${it.list}" data-i="${it.i}" data-k="${it.k}" value="${escapeHtml(it.val)}"></div>` : `<div class="scr ${it.path in editorState.over ? 'changed' : ''}"><button class="t" data-seek="${elementTime(it.e)[0] + 0.5}">${formatTime(toEditedTime(elementTime(it.e)[0]))} · ${escapeHtml(it.label)}</button><input data-path="${it.path}" value="${escapeHtml(get(it.path, it.base))}"></div>`)).join('')}</div>`;
    })
    .join('');
  return `<div class="pane"><div class="lbl">Every word <button class="info" data-tip-id="script">i</button></div>${groups}</div>`;
}
function stylePane() {
  return `<div class="pane">
    <div class="lbl">Colors <button class="info" data-tip-id="colors">i</button></div>
    <div class="brand">${project.brand.colors
      .map((c) => {
        const path = 'brand.color.' + c.id;
        const v = get(path, c.v);
        return `<label class="bc ${path in editorState.over ? 'changed' : ''}"><input type="color" data-bcolor="${c.id}" value="${v}"><span><b>${escapeHtml(c.name)}</b><small>${v.toUpperCase()}</small></span></label>`;
      })
      .join('')}</div>
    <div class="lbl">Fonts <button class="info" data-tip-id="fonts">i</button></div>
    ${project.brand.fonts
      .map((f) => {
        const path = 'brand.font.' + f.id;
        const v = get(path, f.v);
        return `<div class="f ${path in editorState.over ? 'changed' : ''}"><div class="fl">${escapeHtml(f.name)}<span class="sp"></span><button class="undo" data-undo="${path}">Undo</button></div>
        <select data-path="${path}" style="font-family:'${v}'">${[...new Set([v, ...FONTS])].map((o) => `<option ${o === v ? 'selected' : ''} style="font-family:'${o}'">${escapeHtml(o)}</option>`).join('')}</select></div>`;
      })
      .join('')}
    <div class="lbl">Logo</div>
    ${(() => {
      const path = 'brand.logo';
      const v = get(path, project.brand.logo);
      return `<div class="f ${path in editorState.over ? 'changed' : ''}"><div class="media"><div class="th" style="${thumbStyle(v)}">${thumbLabel(v)}</div><span class="nm">${v ? escapeHtml(assetName(v)) : 'No logo yet'}</span><button class="btn sm" data-swap="brand.logo">${v ? 'Swap' : 'Add'}</button><button class="undo" data-undo="${path}">Undo</button></div></div>`;
    })()}
  </div>`;
}
function mediaPane() {
  const mus = get('audio.music', project.audio.music);
  const lib = project.assets;
  return `<div class="pane">
    <div class="drop"><b>Add your files</b>
      <div class="fl" style="justify-content:center">Put them in this project's assets/ folder, or paste a link <button class="info" data-tip-id="add">i</button></div>
      <div class="linkrow"><input type="url" id="linkIn" placeholder="Drive, Dropbox or a website"><button class="btn sm" data-add="link">Add</button></div>
    </div>
    ${editorState.links.length ? `<div class="links">${editorState.links.map((l, i) => `<div><span>${escapeHtml(l.url)}</span>${l.sent ? '<span class="tag ok">Sent</span>' : '<span class="tag">For Claude</span>'}<button class="btn ghost sm" data-del-link="${i}" aria-label="Remove link">×</button></div>`).join('')}</div>` : ''}
    <div class="lbl">In this video <button class="info" data-tip-id="assets">i</button></div>
    <div class="lib">${lib.map((a) => `<div class="ast ${a.mine ? 'mine' : ''}"><div class="th" style="${a.type === 'image' ? thumbStyle(a.id) : ''}">${a.type === 'image' ? '' : a.type.toUpperCase()}</div><span>${escapeHtml(a.name)}</span></div>`).join('')}</div>
    <div class="lbl">Music <button class="info" data-tip-id="music">i</button></div>
    <div class="media"><div class="th">♪</div><span class="nm">${mus ? escapeHtml(assetName(mus)) : 'No track yet'}</span><button class="btn sm" data-swap="audio.music" data-type="audio">${mus ? 'Swap' : 'Add'}</button></div>
    ${project.audio.bpm ? `<div class="fl">Beat drop lands at <b class="mono" style="color:var(--ink)">${project.audio.drop.toFixed(1)}s</b> · ${project.audio.bpm} BPM</div>` : ''}
    <div class="vol"><span class="fl" style="width:56px">Music</span><input type="range" min="0" max="1" step="0.05" data-vol="audio.musicVol" value="${get('audio.musicVol', project.audio.musicVol)}"></div>
    <div class="vol"><span class="fl" style="width:56px">Effects</span><input type="range" min="0" max="1" step="0.05" data-vol="audio.sfxVol" value="${get('audio.sfxVol', project.audio.sfxVol)}"></div>
  </div>`;
}
/* panel events */
function changed() {
  renderTL();
  renderHots();
  markDirty();
  renderQueue();
}
// Undoing a keyframe edit also drops a move: a move on a reel-animated element only made sense with the animation removed.
function undoPath(path) {
  if (conversation.sending) {
    return toast('Sending… Undo again in a moment.');
  } // the request already holds this edit
  const t0 = now();
  delete editorState.over[path];
  if (path.endsWith('.@keys')) {
    delete editorState.over[path.replace(/@keys$/, '@box')];
  }
  if (path.endsWith('.@len')) {
    seek(t0);
  }
  if (path === 'audio.music' || path === 'brand.logo') {
    setupMusic();
  }
  renderPane();
  changed();
}
function touchScene(sid) {
  if (sid && editorState.status[sid] === 'review') {
    editorState.status[sid] = 'changes';
  }
}
/* keyframes: "<id>.@keys" = [{t, box}], 1 or 2, sorted. Replaces "<id>.@box" for that element. */
const onKey = (keys, t) =>
  keys ? keys.findIndex((k) => Math.abs(k.t - t) < 0.5 / project.fps) : -1;
function setKeys(e, keys) {
  delete editorState.over[`${e.id}.@box`];
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const base = e.keys || null;
  if (base ? JSON.stringify(sorted) === JSON.stringify(base) : !sorted.length) {
    delete editorState.over[`${e.id}.@keys`]; // same as reel.json, or nothing to say
  } else {
    editorState.over[`${e.id}.@keys`] = sorted;
  } // includes [] = remove the reel animation
  touchScene(e.s);
  markDirty();
}
// Add a keyframe at t (default: now, with the box shown now). On a keyframe: update it. With 2 already: replace the nearer.
function addKey(e, box = elementBox(e), t = snapToFrame(now())) {
  const keys = (elementKeys(e) || []).map((k) => ({
    ...k,
  }));
  const i = onKey(keys, t);
  if (i >= 0) {
    keys[i].box = box;
  } else if (keys.length < 2) {
    keys.push({
      t,
      box,
    });
  } else {
    keys[Math.abs(keys[0].t - t) <= Math.abs(keys[1].t - t) ? 0 : 1] = {
      t,
      box,
    };
  }
  setKeys(e, keys);
}
// Where a drag or box field lands: a plain move, a keyframe, or a new second keyframe. False when it can't (2 keys, not on one).
function moveTo(e, box) {
  const keys = elementKeys(e);
  const t = snapToFrame(now());
  if (!keys) {
    set(`${e.id}.@box`, box, e.box);
    touchScene(e.s);
    return true;
  }
  if (onKey(keys, t) < 0 && keys.length >= 2) {
    return false;
  }
  addKey(e, box, t);
  return true;
}
const keyTarget = () => {
  const e = ui.mode === 'edit' && ui.sel && elementById(ui.sel);
  return e && e.box && e.s === ui.scene && boxOf(e) ? e : null;
};
function keyNow() {
  const e = keyTarget();
  if (!e) {
    return toast('In Edit, select something on screen first, then press K.');
  }
  pause();
  addKey(e);
  renderPane();
  changed();
  toast(`Keyframe at ${formatTime(toEditedTime(now()))}`);
}
const baseOf = (path) => {
  if (path.startsWith('brand.color.')) {
    return project.brand.colors.find((c) => c.id === path.slice(12)).v;
  }
  if (path.startsWith('brand.font.')) {
    return project.brand.fonts.find((f) => f.id === path.slice(11)).v;
  }
  if (path === 'brand.logo') {
    return project.brand.logo;
  }
  if (path.startsWith('audio.')) {
    return project.audio[path.slice(6)];
  }
  const [id, k] = path.split('.');
  const e = elementById(id);
  return k === '@time' ? e.t : k === '@box' ? e.box : e.props[k].v;
};
const sidOf = (path) => elementById(path.split('.')[0])?.s;
$('#pane').addEventListener('input', (ev) => {
  const t = ev.target;
  const d = t.dataset;
  if (d.path) {
    const v = 'num' in d ? Number(t.value) : t.value;
    set(d.path, v, baseOf(d.path));
    touchScene(sidOf(d.path));
    t.closest('.f,.scr')?.classList.toggle('changed', d.path in editorState.over);
    if (d.path.startsWith('brand.font')) {
      t.style.fontFamily = `'${t.value}'`;
    }
    const card = t.closest('.el');
    if (card) {
      card.classList.toggle('edited', elEdited(elementById(card.dataset.id)));
    }
    return changed();
  }
  if (d.list) {
    const base = baseOf(d.list);
    const rows = JSON.parse(JSON.stringify(get(d.list, base)));
    rows[+d.i][d.k] = t.type === 'number' ? Number(t.value) : t.value;
    set(d.list, rows, base);
    touchScene(sidOf(d.list));
    t.closest('.f,.scr')?.classList.toggle('changed', d.list in editorState.over);
    return changed();
  }
  if (d.time) {
    const e = elementById(d.time);
    const v = [...elementTime(e)];
    v[+d.ix] = Math.round(toRenderTime(Number(t.value)) * 10) / 10;
    set(`${d.time}.@time`, v, e.t);
    touchScene(e.s);
    t.closest('.f').classList.toggle('changed', `${d.time}.@time` in editorState.over);
    return changed();
  }
  if (d.box) {
    const e = elementById(d.box);
    const b = [...elementBox(e)];
    const v = Number(t.value);
    if (!t.value || isNaN(v)) {
      return;
    }
    if (d.ix === 's') {
      const s = Math.max(10, v) / 100;
      b[2] = Math.round(e.box[2] * s * 10) / 10;
      b[3] = Math.round(e.box[3] * s * 10) / 10;
    } else {
      b[+d.ix] = v;
    }
    set(`${d.box}.@box`, b, e.box);
    touchScene(e.s);
    t.closest('.f').classList.toggle('changed', `${d.box}.@box` in editorState.over);
    return changed();
  }
  if (d.key) {
    if (d.ix === 't') {
      return;
    } // times apply on change: re-sorting mid-typing would shift data-i under the cursor
    const e = elementById(d.key);
    const keys = elementKeys(e).map((k) => ({
      ...k,
      box: [...k.box],
    }));
    const k = keys[+d.i];
    const v = Number(t.value);
    if (!t.value || isNaN(v)) {
      return;
    }
    if (d.ix === 's') {
      const s = Math.max(10, v) / 100;
      k.box[2] = Math.round(e.box[2] * s * 10) / 10;
      k.box[3] = Math.round(e.box[3] * s * 10) / 10;
    } else {
      k.box[+d.ix] = v;
    }
    setKeys(e, keys);
    return changed();
  }
  if (d.bcolor) {
    set('brand.color.' + d.bcolor, t.value, baseOf('brand.color.' + d.bcolor));
    t.closest('.bc').classList.toggle('changed', 'brand.color.' + d.bcolor in editorState.over);
    t.nextElementSibling.querySelector('small').textContent = t.value.toUpperCase();
    return changed();
  }
  if (d.vol) {
    set(d.vol, Number(t.value), baseOf(d.vol));
    if (music && d.vol === 'audio.musicVol') {
      music.volume = Number(t.value);
    }
    return changed(false);
  }
});
$('#pane').addEventListener('change', (ev) => {
  const t = ev.target;
  const d = t.dataset;
  if (t.tagName === 'SELECT') {
    return t.dispatchEvent(
      new Event('input', {
        bubbles: true,
      }),
    );
  }
  if (d.key && d.ix === 't') {
    const e = elementById(d.key);
    const keys = elementKeys(e).map((k) => ({
      ...k,
    }));
    const v = Number(t.value);
    if (!t.value || isNaN(v)) {
      return renderPane();
    }
    // keep the time inside the element and one frame clear of the other keyframe, so reel.json `keys` stay valid for check
    const [a, b] = elementTime(e);
    const f = 1 / project.fps;
    const i = +d.i;
    const other = keys[1 - i];
    let nt = clamp(snapToFrame(toRenderTime(clamp(v, 0, editedDuration()))), a, b);
    if (other && Math.abs(other.t - nt) < f / 2) {
      nt = clamp(snapToFrame(nt + (i > 0 || other.t < nt ? f : -f)), a, b);
    }
    if (other && Math.abs(other.t - nt) < f / 2) {
      nt = snapToFrame(other.t + (other.t - f >= a ? -f : f));
    }
    keys[i].t = nt;
    setKeys(e, keys);
    renderPane();
    changed();
  }
});
$('#pane').addEventListener('click', (ev) => {
  const q = (s) => ev.target.closest(s);
  let b;
  if ((b = q('[data-status] button'))) {
    editorState.status[ui.scene] = b.dataset.v;
    markDirty();
    renderPane();
    renderTL();
    return;
  }
  if ((b = q('[data-pick]'))) {
    const id = b.dataset.pick;
    return ui.sel === id ? ((ui.sel = null), renderPane(), renderTL(), renderHots()) : selectEl(id);
  }
  if ((b = q('[data-undo]'))) {
    return undoPath(b.dataset.undo);
  }
  if ((b = q('[data-choice]'))) {
    set(b.dataset.choice, b.dataset.val, baseOf(b.dataset.choice));
    touchScene(sidOf(b.dataset.choice));
    renderPane();
    return changed();
  }
  if ((b = q('[data-color]'))) {
    set(b.dataset.color, b.dataset.val, baseOf(b.dataset.color));
    touchScene(sidOf(b.dataset.color));
    renderPane();
    return changed();
  }
  if ((b = q('[data-del-key]'))) {
    const e = elementById(b.dataset.delKey);
    setKeys(
      e,
      elementKeys(e).filter((_, i) => i !== +b.dataset.i),
    );
    renderPane();
    return changed();
  }
  if ((b = q('[data-swap]'))) {
    return openPicker(b.dataset.swap, b.dataset.i, b.dataset.k, b.dataset.type || 'image');
  }
  if ((b = q('[data-add-row]'))) {
    const p = b.dataset.addRow;
    const base = baseOf(p);
    const rows = JSON.parse(JSON.stringify(get(p, base)));
    rows.push({
      ...rows[rows.length - 1],
    });
    set(p, rows, base);
    touchScene(sidOf(p));
    renderPane();
    return changed();
  }
  if ((b = q('[data-del-row]'))) {
    const p = b.dataset.delRow;
    const base = baseOf(p);
    const rows = JSON.parse(JSON.stringify(get(p, base)));
    rows.splice(+b.dataset.i, 1);
    set(p, rows, base);
    touchScene(sidOf(p));
    renderPane();
    return changed();
  }
  if ((b = q('[data-seek]'))) {
    pause();
    return seek(+b.dataset.seek);
  }
  if ((b = q('[data-add]'))) {
    return addLink();
  }
  if ((b = q('[data-del-link]'))) {
    editorState.links.splice(+b.dataset.delLink, 1);
    markDirty();
    return renderPane();
  }
});
$('#pane').addEventListener('keydown', (ev) => {
  if (ev.target.id === 'linkIn' && ev.key === 'Enter') {
    addLink();
  }
});
function addLink() {
  const i = $('#linkIn');
  const url = i.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    toast('Paste a full link starting with https://');
    return;
  }
  editorState.links.push({
    url,
  });
  i.value = '';
  markDirty();
  renderPane();
  toast('Link added. Claude downloads it when you send.');
}

/* ================= asset picker (assets listed in reel.json) ================= */
function openPicker(path, i, k, type) {
  const lib = project.assets.filter((a) => a.type === type);
  const d = sheet(`<h3>Choose ${type === 'audio' ? 'a track' : 'an image'}</h3>
    ${lib.length ? `<div class="pick">${lib.map((a) => `<button class="ast ${a.id.startsWith('up-') ? 'mine' : ''}" data-pickasset="${a.id}"><div class="th" style="${type === 'image' ? thumbStyle(a.id) : ''}">${type === 'image' ? '' : '♪'}</div><span>${escapeHtml(a.name)}</span></button>`).join('')}</div>` : `<p>Nothing here yet.</p>`}
    <div class="row"><button class="btn ghost" data-close>Cancel</button></div>`);
  const apply = (id) => {
    if (i != null) {
      const base = baseOf(path);
      const rows = JSON.parse(JSON.stringify(get(path, base)));
      rows[+i][k] = id;
      set(path, rows, base);
    } else {
      set(path, id, baseOf(path));
    }
    touchScene(sidOf(path));
    if (path === 'audio.music') {
      setupMusic();
    }
    d.remove();
    renderPane();
    changed();
    toast('Swapped');
  };
  d.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-pickasset]');
    if (b) {
      apply(b.dataset.pickasset);
    }
  });
}

/* ================= selection ================= */
function selectEl(id, keepPlaying) {
  const e = elementById(id);
  const [a, b] = elementTime(e);
  ui.sel = id;
  ui.tab = 'scene';
  if (ui.scene !== e.s) {
    ui.scene = e.s;
  }
  const t = now();
  if (!keepPlaying && (t < a || t > b)) {
    seek(Math.min(a + 0.8, b - 0.05));
  }
  renderTabs();
  renderPane();
  renderTL();
  renderHots();
  document.querySelector(`.el[data-id="${id}"]`)?.scrollIntoView({
    block: 'nearest',
    behavior: 'smooth',
  });
}
const narrow = () => matchMedia('(max-width:1100px)').matches;
function openConvo() {
  if (narrow()) {
    $('#convo').classList.add('open');
  }
}
function closeConvo() {
  $('#convo').classList.remove('open');
}
$('#convoBtn').onclick = () => $('#convo').classList.toggle('open');
$('#convoClose').onclick = closeConvo;
/* ================= conversation pane ================= */
let conversation = {
  entries: [],
  presence: 'idle',
  waiting: 0,
  sending: false,
  sig: '',
};
const { renderMarkdown: md, renderEntry: entryHTML } = createConversationRenderer({
  escapeHtml,
  formatTime,
});

// The transcript and the queue are separate containers: a refresh rewrites #convoT only, so typing in #convoQ is never lost.
function renderTranscript(entries, presence, waiting) {
  const sig = JSON.stringify([entries, presence, waiting]);
  if (sig === conversation.sig) {
    return;
  }
  conversation.sig = sig;
  Object.assign(conversation, {
    entries,
    presence,
    waiting,
  });
  const log = $('#convoLog');
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  $('#convoT').innerHTML = entries.map(entryHTML).join('');
  renderPresence();
  if (atEnd) {
    log.scrollTop = log.scrollHeight;
  }
}
function renderPresence() {
  const p = conversation.presence;
  const [cls, label] =
    p === 'listening'
      ? ['on', 'Agent listening']
      : p === 'working'
        ? ['work', 'Agent working']
        : ['off', 'No agent listening'];
  $('#presence').className = 'pres ' + cls;
  $('#presence span').textContent = label;
  $('#presHint').hidden = !(p === 'idle' && (queueCount() || conversation.waiting));
}
function renderQueue() {
  if (!project || !editorState) {
    return;
  }
  const over = pendingOver();
  const edits = over.filter(([k]) => !k.endsWith('.@len'));
  const trims = over.filter(([k]) => k.endsWith('.@len') && realTrim(k));
  const lab = conversation.sending ? 'Sending' : 'Queued';
  const out = [];
  if (edits.length) {
    out.push(
      `<div class="bub q"><div class="bh"><b>${edits.length} change${edits.length > 1 ? 's' : ''}</b><span class="bst">${lab}</span></div>${edits
        .map(([k, v]) => {
          const r = editRow(k, v);
          return `<div class="ql"><button class="qt" data-qsel="${escapeHtml(k.split('.')[0])}">${escapeHtml(r.element)} · ${escapeHtml(r.field)}: ${escapeHtml(cut(r.from))} → ${escapeHtml(cut(r.to))}</button><button class="undo" data-undo="${escapeHtml(k)}">Undo</button></div>`;
        })
        .join('')}</div>`,
    );
  }
  for (const n of openNotes()) {
    const i = editorState.notes.indexOf(n) + 1;
    const e = n.el && elementById(n.el);
    out.push(
      `<div class="bub q ${ui.selNote === n.id ? 'sel' : ''}" data-note-bub="${n.id}"><div class="bh"><span class="num">${i}</span><button class="go" data-go-note="${n.id}">${formatTime(toEditedTime(n.t))}</button><span>${escapeHtml(e ? e.label : sceneAt(n.t).name)}</span>${isCut(n.t) ? '<span class="tag">Cut</span>' : ''}<span class="bst">${lab}</span><button class="x" data-del-note="${n.id}" aria-label="Delete note">×</button></div><textarea data-note-text="${n.id}" rows="2">${escapeHtml(n.text)}</textarea></div>`,
    );
  }
  for (const [k] of trims) {
    const s = sceneById(k.split('.')[0]);
    out.push(
      `<div class="bub q" data-trim-bub="${s.id}"><div class="bh"><b>Trim ${escapeHtml(s.id)}</b><span>${(s.t[1] - s.t[0]).toFixed(1)}s → ${sceneLen(s).toFixed(1)}s</span><span class="bst">${lab}</span><button class="undo" style="visibility:visible" data-undo="${escapeHtml(k)}">Undo</button></div></div>`,
    );
  }
  editorState.links.forEach((l, i) => {
    if (!l.sent) {
      out.push(
        `<div class="bub q"><div class="bh"><b>Link</b><span class="mono" style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(l.url)}</span><span class="bst">${lab}</span><button class="x" data-del-link="${i}" aria-label="Remove link">×</button></div></div>`,
      );
    }
  });
  (editorState.messages || []).forEach((m) =>
    out.push(
      `<div class="bub q" data-msg="${m.id}"><div class="bh"><b>Message</b><span class="bst">${lab}</span><button class="x" data-del-msg="${m.id}" aria-label="Remove message">×</button></div><div class="md">${md(m.text)}</div></div>`,
    ),
  );
  $('#convoQ').innerHTML = out.join('');
  const n = queueCount();
  const typed = !!$('#msgIn').value.trim();
  $('#queueN').textContent = n ? `${n} queued` : 'Nothing queued';
  $('#sendBtn').disabled = !(n || typed) || conversation.sending;
  $('#sendBtn').textContent = conversation.sending ? 'Sending…' : 'Send to Agent';
  renderPresence();
}
function pollTranscript() {
  return fetch('transcript')
    .then((r) => r.json())
    .then((j) => renderTranscript(j.entries || [], j.presence || 'idle', j.waiting || 0))
    .catch(() => {});
}
$('#convo').addEventListener('click', (ev) => {
  const q = (s) => ev.target.closest(s);
  let b;
  if ((b = q('[data-undo]'))) {
    return undoPath(b.dataset.undo);
  }
  if ((b = q('[data-qsel]'))) {
    const e = elementById(b.dataset.qsel);
    if (e) {
      setMode('edit');
      selectEl(e.id);
    }
    return;
  }
  if ((b = q('[data-go-note]'))) {
    return focusNote(+b.dataset.goNote);
  }
  // a queued item is already in an in-flight request, so removing it now would leave the agent with something the user cancelled
  if (conversation.sending && q('[data-del-note],[data-del-link],[data-del-msg]')) {
    return toast('Sending… remove it again in a moment.');
  }
  if ((b = q('[data-del-note]'))) {
    editorState.notes = editorState.notes.filter((n) => n.id !== +b.dataset.delNote);
    markDirty();
    return renderAll();
  }
  if ((b = q('[data-del-link]'))) {
    editorState.links.splice(+b.dataset.delLink, 1);
    markDirty();
    return renderAll();
  }
  if ((b = q('[data-del-msg]'))) {
    editorState.messages = editorState.messages.filter((m) => m.id !== +b.dataset.delMsg);
    markDirty();
    return renderQueue();
  }
});
$('#convo').addEventListener('input', (ev) => {
  const d = ev.target.dataset;
  if (d.noteText) {
    editorState.notes.find((n) => n.id === +d.noteText).text = ev.target.value;
    markDirty();
  }
});
// Moves the composer's text into the queue as a message. Returns whether there was any.
function queueTyped() {
  const box = $('#msgIn');
  const text = box.value.trim();
  if (!text) {
    return false;
  }
  editorState.messages = [
    ...(editorState.messages || []),
    {
      id: Date.now(),
      text,
    },
  ];
  box.value = '';
  markDirty();
  renderQueue();
  $('#convoLog').scrollTop = $('#convoLog').scrollHeight;
  return true;
}
$('#msgIn').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    queueTyped();
  }
});
$('#msgIn').addEventListener('input', () => {
  $('#sendBtn').disabled = !(queueCount() || $('#msgIn').value.trim()) || conversation.sending;
});
function focusNote(id) {
  const n = editorState.notes.find((n) => n.id === id);
  ui.selNote = id;
  pause();
  seek(n.t);
  openConvo();
  renderQueue();
  document.querySelector(`[data-note-bub="${id}"]`)?.scrollIntoView({
    block: 'nearest',
    behavior: 'smooth',
  });
}

/* ================= send to Claude: structured feedback the agent receives with `motion-os-axi poll` ================= */
const boxStr = (b) => `[${b.join(' ')}]`;
const keysStr = (ks) => ks.map((x) => `${+x.t.toFixed(2)}s ${boxStr(x.box)}`).join(' -> ');
function editRow(path, v) {
  const show = (x) =>
    Array.isArray(x)
      ? x.map((r) => Object.values(r).join(' | ')).join(' / ')
      : typeof x === 'string' && x.includes('/')
        ? assetName(x)
        : typeof x === 'string'
          ? x
          : JSON.stringify(x);
  const style = path.startsWith('brand.color.')
    ? [
        'Style',
        `${project.brand.colors.find((c) => c.id === path.slice(12)).name} color (used everywhere)`,
      ]
    : path.startsWith('brand.font.')
      ? ['Style', `${project.brand.fonts.find((f) => f.id === path.slice(11)).name} font`]
      : path === 'brand.logo'
        ? ['Style', 'Logo']
        : path === 'audio.music'
          ? ['Audio', 'Music track']
          : path === 'audio.musicVol'
            ? ['Audio', 'Music volume']
            : path === 'audio.sfxVol'
              ? ['Audio', 'Effects volume']
              : null;
  if (style) {
    return {
      t: null,
      scene: '',
      element: style[0],
      field: style[1],
      from: show(baseOf(path)),
      to: show(v),
      src: '',
    };
  }
  const [id, k] = path.split('.');
  const e = elementById(id);
  const row = {
    t: +elementTime(e)[0].toFixed(2),
    scene: e.s,
    element: e.label,
    src: e.src || '',
  };
  if (k === '@keys') {
    const from = e.keys?.length ? keysStr(e.keys) : boxStr(e.box);
    if (!v.length) {
      return {
        ...row,
        field: 'keyframes',
        from,
        to: 'none (remove the animation)',
      };
    }
    return v.length === 1 && !e.keys?.length
      ? {
          ...row,
          t: v[0].t,
          field: 'size+position',
          from: boxStr(e.box),
          to: boxStr(v[0].box),
        }
      : {
          ...row,
          t: v[0].t,
          field: 'keyframes',
          from,
          to: keysStr(v) + ' (ease in-out)',
        };
  }
  if (k === '@box') {
    return {
      ...row,
      field: 'size+position',
      from: boxStr(e.box),
      to: `${boxStr(v)} scale ${Math.round((v[2] / e.box[2]) * 100)}%`,
    };
  }
  if (k === '@time') {
    return {
      ...row,
      field: 'timing (s)',
      from: e.t.join('-'),
      to: v.join('-'),
    };
  }
  return {
    ...row,
    field: e.props[k].type === 'motion' ? 'motion' : e.props[k].label,
    from: show(baseOf(path)),
    to: show(v),
  };
}
function feedback() {
  const over = pendingOver();
  return {
    title: project.title,
    id: project.id,
    version: project.version || 1,
    path: project.path || '',
    fps: project.fps,
    duration: project.duration,
    edits: over.filter(([k]) => !k.endsWith('.@len')).map(([k, v]) => editRow(k, v)),
    notes: openNotes().map((n, i) => {
      const e = n.el && elementById(n.el);
      const s = sceneAt(n.t);
      return {
        n: i + 1,
        t: n.t,
        scene: `${s.id} ${s.name}`,
        x: n.x,
        y: n.y,
        on: e ? e.label : '',
        src: e?.src || '',
        text: n.text,
      };
    }),
    trims: over
      .filter(([k]) => k.endsWith('.@len') && realTrim(k))
      .map(([k]) => {
        const s = sceneById(k.split('.')[0]);
        const O = s.t[1] - s.t[0];
        const L = sceneLen(s);
        return {
          scene: s.id,
          name: s.name,
          from: +O.toFixed(2),
          to: +L.toFixed(2),
          drop: `${(s.t[0] + L).toFixed(2)}-${s.t[1].toFixed(2)}s`,
          shift: `-${(O - L).toFixed(2)}s`,
        };
      }),
    links: editorState.links.filter((l) => !l.sent).map((l) => l.url),
    messages: (editorState.messages || []).map((m) => m.text),
    scenes: project.scenes.map((s) => ({
      id: s.id,
      name: s.name,
      status: editorState.status[s.id],
    })),
  };
}
async function sendFeedback() {
  if (conversation.sending) {
    return;
  }
  queueTyped(); // text still in the composer goes with this Send
  if (!queueCount()) {
    return toast('Nothing to send yet. Edit something, press N to pin a note, or type a message.');
  }
  conversation.sending = true;
  renderQueue();
  $('#sendErr').hidden = true;
  try {
    // snapshot what this send contains, so anything queued while it is in flight stays queued
    const body = JSON.stringify(feedback());
    const noteText = new Map(openNotes().map((n) => [n.id, n.text]));
    const snap = JSON.parse(JSON.stringify(editorState.over));
    const links = editorState.links.filter((l) => !l.sent);
    const msgIds = new Set((editorState.messages || []).map((m) => m.id));
    const r = await fetch('feedback', {
      method: 'POST',
      body,
    });
    if (!r.ok) {
      throw new Error(`the player server answered ${r.status}`);
    }
    // a note edited while the request was in flight stays queued, so its new text goes with the next Send
    const noteIds = editorState.notes
      .filter((n) => noteText.has(n.id) && noteText.get(n.id) === n.text)
      .map((n) => n.id);
    editorState.sent = [...new Set([...editorState.sent, ...noteIds])];
    editorState.sentSnap = snap;
    links.forEach((l) => (l.sent = true));
    editorState.messages = (editorState.messages || []).filter((m) => !msgIds.has(m.id));
    conversation.sending = false;
    markDirty();
    renderAll();
    toast('Sent to the agent');
    pollTranscript();
  } catch (e) {
    conversation.sending = false;
    $('#sendErr').textContent = `Couldn't send: ${e.message}. Your queue is kept.`;
    $('#sendErr').hidden = false;
    renderQueue();
  }
}
function sheet(html) {
  const d = document.createElement('div');
  d.className = 'scrim';
  d.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) {
      d.remove();
    }
  });
  document.body.appendChild(d);
  return d;
}
$('#sendBtn').onclick = sendFeedback;

/* ================= export: render a new mp4 with the edits baked in (live projects) ================= */
$('#exportBtn').onclick = async () => {
  const d = sheet(
    `<h3>Export MP4</h3><p id="exMsg">Starting the render…</p><div style="height:6px;border-radius:3px;background:var(--panel-2);overflow:hidden"><i id="exBar" style="display:block;height:100%;width:0;background:var(--accent);transition:width .3s"></i></div><p class="mono" id="exLine" style="font-size:11px"></p><div class="row"><button class="btn ghost" data-close>Close</button></div>`,
  );
  let j = await fetch('export', {
    method: 'POST',
    body: JSON.stringify({
      boxes: liveBoxes(),
      scenes: sceneLens(),
    }),
  }).then((r) => r.json());
  while (j.state === 'running') {
    d.querySelector('#exBar').style.width = j.pct + '%';
    d.querySelector('#exMsg').textContent = `Rendering… ${j.pct}%. You can keep working.`;
    d.querySelector('#exLine').textContent = j.line || '';
    await new Promise((r) => setTimeout(r, 1000));
    j = await fetch('export').then((r) => r.json());
  }
  d.querySelector('#exBar').style.width = j.state === 'done' ? '100%' : '0';
  d.querySelector('#exMsg').innerHTML =
    j.state === 'done'
      ? `Done. Saved as <b class="mono">${escapeHtml(j.out)}</b> · <a href="${escapeHtml(j.out)}" target="_blank">Open it</a>`
      : 'Export failed.';
  d.querySelector('#exLine').textContent = j.state === 'done' ? '' : j.line || '';
  if (j.state === 'done') {
    toast('Exported');
  }
};

/* ================= tooltips ================= */
const tip = $('#tip');
function showTip(el) {
  const text = el.dataset.tip || TIPS[el.dataset.tipId];
  if (!text) {
    return;
  }
  tip.textContent = text;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = clamp(r.left + r.width / 2 - w / 2, 8, innerWidth - w - 8) + 'px';
  tip.style.top = (r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8) + 'px';
}
document.addEventListener('mouseover', (ev) => {
  const el = ev.target.closest('[data-tip],[data-tip-id]');
  el ? showTip(el) : (tip.hidden = true);
});
document.addEventListener('focusin', (ev) => {
  const el = ev.target.closest('[data-tip],[data-tip-id]');
  el ? showTip(el) : (tip.hidden = true);
});
document.addEventListener(
  'click',
  (ev) => {
    const el = ev.target.closest('.info');
    if (el) {
      ev.stopPropagation();
      showTip(el);
    }
  },
  true,
);
document.addEventListener('scroll', () => (tip.hidden = true), true);

/* ================= transport + keys ================= */
$('#playBtn').onclick = () => (playing() ? pause() : play());
$('#noteBtn').onclick = () => setMode(ui.mode === 'note' ? 'preview' : 'note');
$('#keyBtn').onclick = keyNow;
$('#modes').onclick = (e) => {
  const b = e.target.closest('[data-m]');
  if (b) {
    setMode(b.dataset.m);
  }
};
$('#loopBtn').onclick = () => {
  ui.loop = !ui.loop;
  $('#loopBtn').classList.toggle('on', ui.loop);
};
$('#speed').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) {
    return;
  }
  clock.rate = +b.dataset.r;
  video.playbackRate = clock.rate;
  if (music) {
    music.playbackRate = clock.rate;
  }
  [...$('#speed').children].forEach((x) => x.classList.toggle('on', x === b));
};
const sIdx = () => project.scenes.findIndex((s) => s.id === ui.scene);
const goScene = (i) => {
  const s = project.scenes[clamp(i, 0, project.scenes.length - 1)];
  pause();
  ui.sel = null;
  seek(s.t[0] + 0.05);
};
document.addEventListener('keydown', (ev) => {
  if (document.querySelector('.scrim')) {
    if (ev.key === 'Escape') {
      document.querySelector('.scrim').remove();
    }
    return;
  }
  if (ev.target.closest('input,textarea,select')) {
    return;
  }
  const f = 1 / project.fps;
  if (ev.key === ' ') {
    ev.preventDefault();
    playing() ? pause() : play();
  } else if (ev.key === 'ArrowRight') {
    ev.preventDefault();
    pause();
    seek(toRenderTime(toEditedTime(now()) + (ev.shiftKey ? 1 : f)));
  } else if (ev.key === 'ArrowLeft') {
    ev.preventDefault();
    pause();
    seek(toRenderTime(toEditedTime(now()) - (ev.shiftKey ? 1 : f)));
  } else if (ev.key === ']') {
    goScene(sIdx() + 1);
  } else if (ev.key === '[') {
    goScene(sIdx() - 1);
  } else if (ev.key === 'e' || ev.key === 'E') {
    setMode(ui.mode === 'edit' ? 'preview' : 'edit');
  } else if (ev.key === 'n' || ev.key === 'N') {
    setMode(ui.mode === 'note' ? 'preview' : 'note');
  } else if (ev.key === 'k' || ev.key === 'K') {
    keyNow();
  } else if (ev.key === 'Escape') {
    closePop();
    setMode('preview');
    closeConvo();
  }
});
let toastT;
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastT);
  toastT = setTimeout(() => t.remove(), 2200);
}

/* ================= selftest: run selftest() in the browser console ================= */
async function selftest() {
  const { selftest: run } = await import('./browser-selftest.mjs');
  return run({
    P: project,
    st: editorState,
    ui,
    convo: conversation,
    addKey,
    allEls: allElements,
    edDur: editedDuration,
    editRow,
    elBox: elementBox,
    elById: elementById,
    elKeys: elementKeys,
    elTime: elementTime,
    entryHTML,
    feedback,
    fps1: snapToFrame,
    isCut,
    liveBoxes,
    loopEnd,
    markDirty,
    md,
    moveTo,
    nextAfterCut,
    now,
    openNotes,
    pendingEdits,
    pruneMissing,
    pruneReelBoxes,
    queueCount,
    renderAll,
    renderPane,
    renderQueue,
    renderTL,
    renderTranscript,
    sceneAt,
    sceneEnd,
    sceneLen,
    sceneLens,
    sceneOf: sceneById,
    seek,
    sendFeedback,
    set,
    setKeys,
    setTrim,
    toEd: toEditedTime,
    toSrc: toRenderTime,
    undoPath,
    vid: video,
    setVideo: (value) => {
      video = value;
    },
  });
}
window.selftest = selftest;

// Load reel.json, optionally jump to #t=12.5&el=id, then watch for the next version Claude renders.
const hash = new URLSearchParams(location.hash.slice(1));
fetch('reel.json', {
  cache: 'no-store',
})
  .then((r) => r.json())
  .then(async (j) => {
    project = j;
    if (project.live) {
      await new Promise((ok, no) => {
        const s = document.createElement('script');
        s.src = project.live + '?v=' + (project.version || 1);
        s.onload = ok;
        s.onerror = no;
        document.head.appendChild(s);
      });
      $('#vid').hidden = true;
      const el = document.createElement('div');
      el.id = 'rp';
      $('#viewer').insertBefore(el, overlay);
      live = (window.MotionOSAXILive || window.MotionOSLive)(el);
      video = liveVideo(live, {
        toEd: toEditedTime,
        toSrc: toRenderTime,
        fps: project.fps,
      });
    }
    wireVideo();
    loadProject();
    pollTranscript();
    setInterval(pollTranscript, 2000);
    $('#exportBtn').hidden = !project.export;
    if (hash.get('t')) {
      video.addEventListener(
        'loadedmetadata',
        () => {
          seek(+hash.get('t'));
          if (hash.get('el') && elementById(hash.get('el'))) {
            selectEl(hash.get('el'));
          }
        },
        {
          once: true,
        },
      );
    }
    setInterval(
      () =>
        fetch('reel.json', {
          cache: 'no-store',
        })
          .then((r) => r.json())
          .then((n) => {
            if ((n.version || 1) !== (project.version || 1)) {
              toast(`v${n.version} is ready. Loading it.`);
              setTimeout(() => location.reload(), 900);
            }
          })
          .catch(() => {}),
      3000,
    );
  })
  .catch(() => {
    $('#pane').innerHTML =
      '<div class="pane"><div class="empty">No reel.json next to this page.<br>Start Motion OS AXI from Claude, or run: node player/serve.mjs your-project</div></div>';
  });
