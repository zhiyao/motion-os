// Turns queued Send batches into the TOON-ready object `poll` prints. Times are render time (before trims), in seconds.
import { trunc } from './toon.mjs';
export function formatFeedback(batches, { full = false } = {}) {
  const last = batches[batches.length - 1].payload;
  const all = (k) => batches.flatMap((b) => b.payload[k] || []);
  const edits = all('edits').map((e) => ({
    ...e,
    from: trunc(e.from, full),
    to: trunc(e.to, full),
  }));
  const notes = all('notes').map((n, i) => ({
    ...n,
    n: i + 1,
    text: trunc(n.text, full),
  }));
  const trims = Object.values(Object.fromEntries(all('trims').map((t) => [t.scene, t]))); // the latest trim per scene wins
  const links = [...new Set(all('links'))];
  const messages = all('messages').map((m) => trunc(m, full));
  const o = {
    feedback: `${last.title} v${last.version} → set version ${last.version + 1}`,
    clock: 'render time (before trims), seconds',
    counts: `edits=${edits.length} notes=${notes.length} trims=${trims.length} links=${links.length} messages=${messages.length}`,
  };
  if (messages.length) {
    o.messages = messages;
  }
  if (edits.length) {
    o.edits = edits;
  }
  if (notes.length) {
    o.notes = notes;
  }
  if (trims.length) {
    o.trims = trims;
  }
  if (links.length) {
    o.links = links;
  }
  o.scenes = last.scenes || [];
  return o;
}
