import { keepAfterNewVersion } from './model.mjs';
export const stateKey = (project) => 'motion-os-axi:' + project.id;
export function loadState(project, storage) {
  const ver = project.version || 1;
  let stored;
  try {
    stored = JSON.parse(
      storage.getItem(stateKey(project)) || storage.getItem('motionos:' + project.id) || 'null',
    );
  } catch {}
  const state = Object.assign(
    {
      over: {},
      notes: structuredClone(project.notes || []),
      status: {},
      links: [],
      sent: [],
      sentSnap: {},
      messages: [],
      ver,
    },
    stored || {},
  );
  if (state.ver !== ver) {
    state.over = keepAfterNewVersion(state.over, state.sentSnap);
    state.notes = state.notes.filter((n) => !state.sent.includes(n.id));
    state.links = state.links.filter((l) => !l.sent);
    state.sent = [];
    state.sentSnap = {};
    state.ver = ver;
  }
  return state;
}
export function saveState(project, state, storage) {
  try {
    storage.setItem(stateKey(project), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
