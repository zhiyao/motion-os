// reel.json validation for `motion-os-axi check`. checkReelData is pure; checkReel reads the project folder.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export function checkReelData(r, {exists = () => true, mp4Duration = null} = {}){
  const P = [], err = (where, message) => P.push({level: 'error', where, message}), warn = (where, message) => P.push({level: 'warn', where, message});
  if (!r || typeof r !== 'object' || Array.isArray(r)) return [{level: 'error', where: 'reel', message: 'reel.json must be an object'}];
  // project paths must stay inside the project: the player can't serve anything else, so check, playback and frame would disagree
  const inside = p => !path.isAbsolute(p) && !path.normalize(p).split(/[\\/]/).includes('..');
  const file = (where, p, what) => { const name = what ? `${what} ${p}` : p; if (!inside(p)) err(where, `${name} is outside the project`); else if (!exists(p)) err(where, `${name} not found`); };
  for (const k of ['id', 'version', 'src', 'fps', 'duration', 'scenes']) if (r[k] == null) err('reel', `missing "${k}"`);
  if (!Array.isArray(r.scenes)) return P;
  if (!r.scenes.length) { err('reel', 'needs at least one scene'); return P; }
  const tol = 1 / (r.fps || 30) + 1e-6, ids = new Set(), seen = id => { if (ids.has(id)) err(id, 'duplicate id'); ids.add(id); };
  const span = t => Array.isArray(t) && t.length === 2 && t.every(n => typeof n === 'number' && Number.isFinite(n)) && t[1] > t[0];   // end after start
  r.scenes.forEach((s, i) => {
    if (!s || typeof s !== 'object') return err(`scene ${i + 1}`, 'must be an object');
    if (typeof s.id !== 'string' || !s.id) err(`scene ${i + 1}`, 'missing id'); else seen(s.id);
    if (!Array.isArray(s.els)) err(s.id ?? `scene ${i + 1}`, 'els must be an array');
    if (!span(s.t)) return err(s.id ?? `scene ${i + 1}`, 't must be [start, end] in seconds');
    const prev = span(r.scenes[i - 1]?.t) ? r.scenes[i - 1] : null;
    if (i === 0 && Math.abs(s.t[0]) > tol) err(s.id, `starts at ${s.t[0]}s, not 0`);
    if (prev && s.t[0] - prev.t[1] > tol) err(s.id, `gap after ${prev.id} (${prev.t[1]}s to ${s.t[0]}s)`);
    if (prev && prev.t[1] - s.t[0] > tol) err(s.id, `overlaps ${prev.id} (starts ${s.t[0]}s, ${prev.id} ends ${prev.t[1]}s)`);
    for (const e of Array.isArray(s.els) ? s.els : []) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id) { err(s.id ?? `scene ${i + 1}`, 'an element has no id'); continue; }
      seen(e.id);
      if (!span(e.t)) err(e.id, 't must be [start, end] in seconds');
      if (!e.props || typeof e.props !== 'object' || Array.isArray(e.props)) err(e.id, 'props must be an object');
      const b = e.box;
      if (b != null && !(Array.isArray(b) && b.length === 4 && b.every(n => typeof n === 'number' && n >= 0 && n <= 100) && b[0] + b[2] <= 100.5 && b[1] + b[3] <= 100.5))
        err(e.id, `box ${JSON.stringify(b)} is not [x, y, w, h] inside 0-100`);
      if (Array.isArray(e.t) && (e.t[0] < s.t[0] - tol || e.t[1] > s.t[1] + tol)) err(e.id, `time ${e.t[0]}-${e.t[1]}s is outside ${s.id} (${s.t[0]}-${s.t[1]}s)`);
      if (e.keys != null && e.box == null) err(e.id, 'keys need a box');
      else if (e.keys != null) {
        const k = e.keys, ok = Array.isArray(k) && k.length >= 1 && k.length <= 2 && k.every(x => typeof x?.t === 'number' && Array.isArray(x.box) && x.box.length === 4 && x.box.every(n => typeof n === 'number'));
        if (!ok) err(e.id, 'keys must be 1 or 2 {t, box: [x, y, w, h]} entries');
        else {
          if (k[1] && k[1].t <= k[0].t) err(e.id, 'keys are not in time order');
          if (Array.isArray(e.t) && k.some(x => x.t < e.t[0] - tol || x.t > e.t[1] + tol)) err(e.id, `a keyframe is outside its time ${e.t[0]}-${e.t[1]}s`);
        }
      }
      for (const [k, p] of Object.entries(e.props || {}))
        if (!p || typeof p !== 'object') err(e.id, `prop ${k} is empty`);
        else if (p.type === 'media' && typeof p.v === 'string' && p.v.includes('/')) file(e.id, p.v, `${k}: file`);
    }
  });
  const last = r.scenes[r.scenes.length - 1];
  if (last && span(last.t) && r.duration != null && Math.abs(last.t[1] - r.duration) > tol) err(last.id, `ends at ${last.t[1]}s but duration is ${r.duration}s`);
  if (typeof r.src === 'string') file('reel', r.src, 'src');
  for (const a of r.assets || []) if (typeof a?.id !== 'string') err('assets', 'an asset has no id'); else if (a.id.includes('/')) file('assets', a.id, '');
  if (mp4Duration != null && r.duration != null && Math.abs(mp4Duration - r.duration) > 0.1) warn('reel', `duration ${r.duration}s but ${r.src} is ${mp4Duration.toFixed(2)}s`);
  if (r.live && (!inside(r.live) || !exists(r.live))) warn('reel', `live bundle ${r.live} not found`);
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
