// Where Motion OS AXI keeps state: the player registry (~/.motion-os-axi/players/, one file per running player)
// and each project's feedback queue (<project>/.motion-os-axi/inbox.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Legacy names remain only to preserve existing registries and project feedback.
export const home = () => process.env.MOTION_OS_AXI_HOME || process.env.MOTION_OS_HOME || storageDir(os.homedir());
export function storageDir(dir){
  const current = path.join(dir, '.motion-os-axi'), legacy = path.join(dir, '.motion-os');
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}
const regDir = () => path.join(home(), 'players');
const regFile = dir => path.join(regDir(), crypto.createHash('sha1').update(dir).digest('hex').slice(0, 16) + '.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), {recursive: true}); const t = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); };
export const newId = () => Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Each player owns its own file, so players starting at the same moment can't overwrite each other.
export function readPlayers(){
  let files = []; try { files = fs.readdirSync(regDir()).filter(f => f.endsWith('.json')); } catch {}
  const live = {};
  for (const f of files) {
    const p = readJson(path.join(regDir(), f), null);
    if (p && alive(p.pid)) live[p.dir] = {port: p.port, pid: p.pid, started: p.started};
    else if (p) try { fs.unlinkSync(path.join(regDir(), f)); } catch {}
  }
  return live;
}
export function addPlayer(dir, port){ writeJson(regFile(dir), {dir, port, pid: process.pid, started: Date.now()}); }
// Only removes our own entry (or a dead one), so an old server exiting can't unregister a newer one for the same project.
export function removePlayer(dir){ const f = regFile(dir), p = readJson(f, null); if (p && (p.pid === process.pid || !alive(p.pid))) try { fs.unlinkSync(f); } catch {} }

// Queue: batches stay in the file until acked. leaseQueue hands out the unleased ones and marks them leased for `ms`;
// if no ack arrives in time (the poll was killed, or gave up as the reply came), they are handed out again.
export const queuePath = dir => path.join(storageDir(dir), 'inbox.json');
export const readQueue = dir => readJson(queuePath(dir), []);
export function pushBatch(dir, payload){
  const q = readQueue(dir), b = {id: newId(), at: new Date().toISOString(), version: payload?.version ?? null, payload};
  writeJson(queuePath(dir), [...q, b]); return b;
}
export function leaseQueue(dir, ms = 30000){
  // one reel version at a time: batches from an older version carry that version's render times, so they're never merged with newer ones
  const q = readQueue(dir), now = Date.now(), open = q.filter(b => !(b.leased > now)), free = open.filter(b => b.version === open[0]?.version);
  if (free.length) writeJson(queuePath(dir), q.map(b => free.includes(b) ? {...b, leased: now + ms} : b));
  return free;
}
export function ackQueue(dir, ids){ const q = readQueue(dir), keep = q.filter(b => !ids.includes(b.id)); if (keep.length !== q.length) writeJson(queuePath(dir), keep); }

// Transcript: what the user sent and what the agent replied, shown in the player's Conversation pane.
export const transcriptPath = dir => path.join(storageDir(dir), 'transcript.json');
export const readTranscript = dir => readJson(transcriptPath(dir), []);
export function appendTranscript(dir, entry){ const e = {id: newId(), at: new Date().toISOString(), ...entry}; writeJson(transcriptPath(dir), [...readTranscript(dir), e]); return e; }
// Sets status on user entries matching pred (skipping ones already there); returns how many changed.
export function markTranscript(dir, pred, status){
  let n = 0; const t = readTranscript(dir).map(e => e.role === 'user' && pred(e) && e.status !== status ? (n++, {...e, status, ...(status === 'picked' ? {pickedAt: Date.now()} : {})}) : e);
  if (n) writeJson(transcriptPath(dir), t); return n;
}
// "Agent working" means a batch was picked up recently and not replied to; after 30 minutes the agent is presumed gone.
export const isWorking = (entries, now = Date.now()) => entries.some(e => e.role === 'user' && e.status === 'picked' && now - (e.pickedAt || 0) < 30 * 60e3);
// The ids the last poll handed to the agent, so its --reply closes exactly those batches.
const deliveredPath = dir => path.join(storageDir(dir), 'last-delivered.json');
// Ids accumulate until a reply closes them, so a poll re-run after an interruption doesn't orphan the earlier batch.
export function setDelivered(dir, ids){ writeJson(deliveredPath(dir), [...new Set([...readDelivered(dir), ...ids])]); }
export const readDelivered = dir => readJson(deliveredPath(dir), []);
export function clearDelivered(dir){ try { fs.unlinkSync(deliveredPath(dir)); } catch {} }
export function takeDelivered(dir){ const ids = readDelivered(dir); clearDelivered(dir); return ids; }
