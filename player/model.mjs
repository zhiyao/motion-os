// Editing math and selectors, independent of the DOM and storage.
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const easeInOut = p => (p = clamp(p), p < .5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
export function keyBox(keys, t) {
  const [a, b] = keys;
  if (!b || t <= a.t) return a.box;
  if (t >= b.t) return b.box;
  const p = easeInOut((t - a.t) / (b.t - a.t));
  return a.box.map((v, i) => Math.round((v + (b.box[i] - v) * p) * 10) / 10);
}
export const keepAfterNewVersion = (over, snap) => Object.fromEntries(Object.entries(over).filter(([k, v]) => JSON.stringify(snap[k]) !== JSON.stringify(v)));

export function indexProject(project) {
  const scenes = new Map(project.scenes.map(s => [s.id, s]));
  const elements = new Map(project.scenes.flatMap(s => s.els.map(e => [e.id, {element: e, scene: s.id}])));
  return {
    sceneOf: id => scenes.get(id),
    elById: id => { const entry = elements.get(id); return entry && {...entry.element, s: entry.scene}; },
    allEls: () => [...elements.values()].map(({element, scene}) => ({...element, s: scene})),
  };
}

export function pathExists(project, index, key) {
  if (key.startsWith('brand.color.')) return !!project.brand?.colors?.some(c => c.id === key.slice(12));
  if (key.startsWith('brand.font.')) return !!project.brand?.fonts?.some(f => f.id === key.slice(11));
  if (key === 'brand.logo' || key.startsWith('audio.')) return true;
  const [id, field = ''] = key.split('.');
  if (field === '@len') return !!index.sceneOf(id);
  const element = index.elById(id);
  if (!element) return false;
  if (field === '@box' || field === '@keys') return !!element.box;
  return field.startsWith('@') || field in element.props;
}

export function pendingOverrides(over, sentSnap, exists, realTrim) {
  return Object.entries(over).filter(([key, value]) =>
    JSON.stringify(sentSnap[key]) !== JSON.stringify(value) && exists(key) &&
    (!key.endsWith('.@len') || realTrim(key)));
}

// Accessors allow edits to update without rebuilding the timeline controller.
export function createTimeline(project, getOverride) {
  const sceneAt = t => project.scenes.find(s => t < s.t[1] - 1e-6) || project.scenes.at(-1);
  const sceneLen = s => Math.min(getOverride(`${s.id}.@len`, s.t[1] - s.t[0]), s.t[1] - s.t[0]);
  const sceneEnd = s => s.t[0] + sceneLen(s);
  const sceneLayout = () => {
    let E = 0;
    return project.scenes.map(s => { const o = {s, S: s.t[0], L: sceneLen(s), E}; E += o.L; return o; });
  };
  const isCut = t => t > sceneEnd(sceneAt(t)) + 1e-6;
  return {
    sceneAt, sceneLen, sceneEnd, sceneLayout, isCut,
    edDur: () => project.scenes.reduce((n, s) => n + sceneLen(s), 0),
    toEd(t) { const o = sceneLayout().find(o => o.s === sceneAt(t)); return o.E + clamp(t - o.S, 0, o.L); },
    toSrc(t) { const ls = sceneLayout(), o = ls.find(o => t < o.E + o.L) || ls.at(-1); return o.S + clamp(t - o.E, 0, o.L); },
    nextAfterCut(t) { if (!isCut(t)) return null; const i = project.scenes.indexOf(sceneAt(t)); return i < project.scenes.length - 1 ? project.scenes[i + 1].t[0] : -1; },
  };
}
