// Where Motion OS AXI keeps state: the player registry (~/.motion-os-axi/players/, one file per running player)
// and each project's feedback queue (<project>/.motion-os-axi/inbox.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Legacy names remain only to preserve existing registries and project feedback.
export const home = () =>
  process.env.MOTION_OS_AXI_HOME || process.env.MOTION_OS_HOME || storageDir(os.homedir());
export function storageDir(dir) {
  const current = path.join(dir, '.motion-os-axi');
  const legacy = path.join(dir, '.motion-os');
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}
const registryDirectory = () => path.join(home(), 'players');
const registryFile = (dir) =>
  path.join(
    registryDirectory(),
    crypto.createHash('sha1').update(dir).digest('hex').slice(0, 16) + '.json',
  );
const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true,
  });
  const temporaryFile = filePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporaryFile, JSON.stringify(value, null, 1));
  fs.renameSync(temporaryFile, filePath);
};
export const newId = () => Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
const isProcessAlive = (pid) => {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// Each player owns its own file, so players starting at the same moment can't overwrite each other.
export function readPlayers() {
  let files = [];
  try {
    files = fs.readdirSync(registryDirectory()).filter((f) => f.endsWith('.json'));
  } catch {}
  const players = {};
  for (const f of files) {
    const p = readJson(path.join(registryDirectory(), f), null);
    if (p && isProcessAlive(p.pid)) {
      players[p.dir] = {
        port: p.port,
        pid: p.pid,
        started: p.started,
      };
    } else if (p) {
      try {
        fs.unlinkSync(path.join(registryDirectory(), f));
      } catch {}
    }
  }
  return players;
}
export function addPlayer(dir, port) {
  writeJson(registryFile(dir), {
    dir,
    port,
    pid: process.pid,
    started: Date.now(),
  });
}
// Only removes our own entry (or a dead one), so an old server exiting can't unregister a newer one for the same project.
export function removePlayer(dir) {
  const filePath = registryFile(dir);
  const player = readJson(filePath, null);
  if (player && (player.pid === process.pid || !isProcessAlive(player.pid))) {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
}

// Queue: batches stay in the file until acked. leaseQueue hands out the unleased ones and marks them leased for `ms`;
// if no ack arrives in time (the poll was killed, or gave up as the reply came), they are handed out again.
export const queuePath = (dir) => path.join(storageDir(dir), 'inbox.json');
export const readQueue = (dir) => readJson(queuePath(dir), []);
export function pushBatch(dir, payload) {
  const queue = readQueue(dir);
  const batch = {
    id: newId(),
    at: new Date().toISOString(),
    version: payload?.version ?? null,
    payload,
  };
  writeJson(queuePath(dir), [...queue, batch]);
  return batch;
}
export function leaseQueue(dir, leaseDurationMs = 30000) {
  // one reel version at a time: batches from an older version carry that version's render times, so they're never merged with newer ones
  const queue = readQueue(dir);
  const now = Date.now();
  const availableBatches = queue.filter((batch) => !(batch.leased > now));
  const leasedBatches = availableBatches.filter(
    (batch) => batch.version === availableBatches[0]?.version,
  );
  if (leasedBatches.length) {
    writeJson(
      queuePath(dir),
      queue.map((batch) =>
        leasedBatches.includes(batch)
          ? {
              ...batch,
              leased: now + leaseDurationMs,
            }
          : batch,
      ),
    );
  }
  return leasedBatches;
}
export function ackQueue(dir, ids) {
  const queue = readQueue(dir);
  const remainingBatches = queue.filter((batch) => !ids.includes(batch.id));
  if (remainingBatches.length !== queue.length) {
    writeJson(queuePath(dir), remainingBatches);
  }
}

// Transcript: what the user sent and what the agent replied, shown in the player's Conversation pane.
export const transcriptPath = (dir) => path.join(storageDir(dir), 'transcript.json');
export const readTranscript = (dir) => readJson(transcriptPath(dir), []);
export function appendTranscript(dir, inputEntry) {
  const entry = {
    id: newId(),
    at: new Date().toISOString(),
    ...inputEntry,
  };
  writeJson(transcriptPath(dir), [...readTranscript(dir), entry]);
  return entry;
}
// Sets status on user entries matching pred (skipping ones already there); returns how many changed.
export function markTranscript(dir, matchesEntry, status) {
  let changedCount = 0;
  const entries = readTranscript(dir).map((entry) => {
    if (entry.role !== 'user' || !matchesEntry(entry) || entry.status === status) {
      return entry;
    }
    changedCount += 1;
    return {
      ...entry,
      status,
      ...(status === 'picked'
        ? {
            pickedAt: Date.now(),
          }
        : {}),
    };
  });
  if (changedCount > 0) {
    writeJson(transcriptPath(dir), entries);
  }
  return changedCount;
}
// "Agent working" means a batch was picked up recently and not replied to; after 30 minutes the agent is presumed gone.
export const isWorking = (entries, now = Date.now()) =>
  entries.some(
    (e) => e.role === 'user' && e.status === 'picked' && now - (e.pickedAt || 0) < 30 * 60e3,
  );
// The ids the last poll handed to the agent, so its --reply closes exactly those batches.
const deliveredPath = (dir) => path.join(storageDir(dir), 'last-delivered.json');
// Ids accumulate until a reply closes them, so a poll re-run after an interruption doesn't orphan the earlier batch.
export function setDelivered(dir, ids) {
  writeJson(deliveredPath(dir), [...new Set([...readDelivered(dir), ...ids])]);
}
export const readDelivered = (dir) => readJson(deliveredPath(dir), []);
export function clearDelivered(dir) {
  try {
    fs.unlinkSync(deliveredPath(dir));
  } catch {}
}
export function takeDelivered(dir) {
  const ids = readDelivered(dir);
  clearDelivered(dir);
  return ids;
}
