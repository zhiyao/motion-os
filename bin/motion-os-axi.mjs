#!/usr/bin/env node
// motion-os-axi: the agent-facing CLI for Motion OS AXI (https://axi.md). Zero dependencies.
// stdout is TOON; every output ends with help[] next steps; errors exit 1, usage errors exit 2.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { toon } from './toon.mjs';
import { checkReel } from './check.mjs';
import {
  storageDir,
  readPlayers,
  readQueue,
  leaseQueue,
  ackQueue,
  appendTranscript,
  markTranscript,
  setDelivered,
  readDelivered,
  clearDelivered,
} from './store.mjs';
import { formatFeedback } from './format.mjs';
import { resolveProjectFile } from './project-files.mjs';
const BIN = fileURLToPath(import.meta.url);
const AXI = `node ${BIN}`;
const SERVE = fileURLToPath(new URL('../player/serve.mjs', import.meta.url));
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const VALUED = new Set(['--timeout', '--reply']);
const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
const optVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const full = flags.has('--full');
function out(obj, help = []) {
  console.log(
    toon({
      ...obj,
      ...(help.length
        ? {
            help,
          }
        : {}),
    }),
  );
}
function fail(code, message, help = []) {
  out(
    {
      error: code,
      message,
    },
    help,
  );
  process.exit(1);
}
function usage(message) {
  out(
    {
      error: 'usage',
      message,
    },
    [`Run \`${AXI} --help\``],
  );
  process.exit(2);
}
const projectDir = (p) => path.resolve(p || '.');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const player = (dir) => {
  const p = readPlayers()[dir];
  return (
    p && {
      ...p,
      url: `http://localhost:${p.port}`,
    }
  );
};
const readReel = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'reel.json'), 'utf8'));
  } catch {
    return null;
  }
};
const openBrowser = (url) =>
  process.platform === 'win32'
    ? execFile('cmd', ['/c', 'start', '', url])
    : execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
const COMMANDS = {
  open: {
    usage: 'open <project> [--no-open]',
    about: 'Start (or reuse) the player for a project and print its URL',
    flags: ['--no-open'],
    run: cmdOpen,
  },
  check: {
    usage: 'check <project>',
    about: 'Validate reel.json: scene timing, ids, boxes, files, duration',
    flags: [],
    run: cmdCheck,
  },
  poll: {
    usage: 'poll <project> [--timeout <s>] [--reply "<text>"]',
    about:
      'Optionally post a reply to the Conversation pane, then wait for the user to press Send; prints their messages, edits, notes and trims',
    flags: ['--timeout', '--reply'],
    run: cmdPoll,
  },
  frame: {
    usage: 'frame <project> <t>',
    about: 'Save the frame at t seconds (render time) as a jpg',
    flags: [],
    run: cmdFrame,
  },
  export: {
    usage: 'export <project> [--wait]',
    about: 'Status of the Export MP4 the user started in the player',
    flags: ['--wait'],
    run: cmdExport,
  },
  stop: {
    usage: 'stop [<project>]',
    about: 'Stop one player, or all of them',
    flags: [],
    run: cmdStop,
  },
  'setup-hook': {
    usage: 'setup-hook',
    about: 'Print a Claude Code SessionStart hook that shows running players at session start',
    flags: [],
    run: cmdHook,
  },
};
function cmdStatus() {
  const ps = Object.entries(readPlayers()).map(([dir, p]) => {
    const reel = readReel(dir) || {};
    return {
      project: dir,
      url: `http://localhost:${p.port}`,
      version: reel.version ?? null,
      scenes: reel.scenes?.length ?? null,
      waiting: readQueue(dir).length,
    };
  });
  out(
    {
      bin: BIN,
      description:
        "Motion OS AXI: build a video in code, review it in a local player, get the user's feedback back with poll",
      players: ps.length ? ps : 'none running',
    },
    ps.length
      ? [
          `Run \`${AXI} poll <project>\` to wait for the user's feedback`,
          `Run \`${AXI} check <project>\` after each re-render`,
        ]
      : [
          `Run \`${AXI} open <project>\` to open a project (a folder with reel.json) in the player`,
          `Run \`${AXI} --help\` for all commands`,
        ],
  );
}
async function cmdOpen() {
  const dir = projectDir(pos[1]);
  if (!fs.existsSync(path.join(dir, 'reel.json'))) {
    fail('no_reel', `no reel.json in ${dir}`, [
      'Write reel.json first (see the motion-os-axi skill, step 4)',
    ]);
  }
  const errors = checkReel(dir).problems.filter((p) => p.level === 'error').length;
  let p = player(dir);
  let status = 'reused';
  if (!p) {
    fs.mkdirSync(storageDir(dir), {
      recursive: true,
    });
    const log = fs.openSync(path.join(storageDir(dir), 'server.log'), 'a');
    try {
      spawn(process.execPath, [SERVE, dir, '--no-open'], {
        detached: true,
        stdio: ['ignore', log, log],
      }).unref();
    } finally {
      fs.closeSync(log);
    }
    for (let i = 0; i < 50 && !(p = player(dir)); i++) {
      await sleep(100);
    }
    if (!p) {
      fail(
        'start_failed',
        `the player didn't start; see ${path.join(storageDir(dir), 'server.log')}`,
      );
    }
    status = 'started';
  }
  if (!flags.has('--no-open')) {
    openBrowser(p.url);
  }
  out(
    {
      project: dir,
      url: p.url,
      version: readReel(dir)?.version ?? null,
      status,
      ...(errors
        ? {
            problems: `${errors} (run check)`,
          }
        : {}),
    },
    [
      "Tell the user: Preview plays it; Edit (E) to change things; N pins a note; K keyframes; drag a scene's end to trim; press Send when done",
      `Run \`${AXI} poll ${dir}\` and keep it running until the user sends feedback`,
    ],
  );
}
function cmdCheck() {
  const dir = projectDir(pos[1]);
  const { problems } = checkReel(dir);
  const errors = problems.filter((p) => p.level === 'error').length;
  out(
    {
      project: dir,
      problems: problems.length,
      errors,
      ...(problems.length
        ? {
            problems,
          }
        : {}),
    },
    errors
      ? [`Fix the errors in reel.json (or the render), then run \`${AXI} check <project>\` again`]
      : [`Run \`${AXI} open <project>\` to review it in the player`],
  );
  if (errors) {
    process.exit(1);
  }
}
async function cmdPoll() {
  if (flags.has('--timeout')) {
    const v = optVal('--timeout');
    if (v == null || v.startsWith('--') || !Number.isFinite(Number(v)) || Number(v) < 0) {
      usage('--timeout needs a number of seconds (0 = wait forever)');
    }
  }
  const dir = projectDir(pos[1]);
  const limit = Number(optVal('--timeout') || 0) * 1000;
  const t0 = Date.now();
  if (flags.has('--reply')) {
    const text = optVal('--reply');
    if (!text || text.startsWith('--')) {
      usage('--reply needs the text of your reply');
    }
    const p = player(dir);
    const ids = readDelivered(dir); // close only the batches the last polls handed over; cleared once the reply lands
    if (p) {
      const r = await fetch(p.url + '/reply', {
        method: 'POST',
        body: JSON.stringify({
          text,
          ids,
        }),
      }).catch(() => null);
      if (!r?.ok) {
        fail('reply_failed', 'the player did not accept the reply; run the same command again');
      }
    } else {
      appendTranscript(dir, {
        role: 'agent',
        text,
      });
      markTranscript(dir, (e) => ids.includes(e.id), 'done');
    }
    clearDelivered(dir);
  }
  const show = (batches) =>
    out(
      formatFeedback(batches, {
        full,
      }),
      [
        'Apply edits exactly, then work through the notes; leave scenes with status approved untouched',
        `Look at a note's spot first: \`${AXI} frame ${dir} <t>\``,
        "Download links into assets/ (ask first unless clearly the user's own file)",
        `Apply trims last; re-render, run \`${AXI} check ${dir}\`, set reel.json "version" as shown in feedback`,
        `When done, reply with a short summary of what changed: \`${AXI} poll ${dir} --reply "..."\` (this also waits for the next Send)`,
      ],
    );
  for (;;) {
    const p = player(dir);
    if (!p) {
      const q = leaseQueue(dir);
      if (q.length) {
        const ids = q.map((b) => b.id);
        markTranscript(dir, (e) => ids.includes(e.id), 'picked');
        show(q);
        setDelivered(dir, ids);
        return ackQueue(dir, ids);
      }
      fail('no_player', `no player running for ${dir}`, [`Run \`${AXI} open ${dir}\``]);
    }
    const left = limit ? limit - (Date.now() - t0) : 25000;
    if (limit && left <= 0) {
      return out(
        {
          feedback: 'none yet',
        },
        [`Run \`${AXI} poll ${dir}\` again to keep waiting`],
      );
    }
    try {
      // the server answers within `ms`; the client gives it 5 s more so it never drops a reply that is on its way
      const ms = Math.max(100, Math.min(left, 25000));
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms + 5000);
      let j;
      try {
        j = await fetch(`${p.url}/poll?ms=${ms}`, {
          signal: ctl.signal,
        }).then((r) => {
          if (!r.ok) {
            throw new Error(`poll: HTTP ${r.status}`);
          }
          return r.json();
        });
      } finally {
        clearTimeout(timer);
      }
      if (j.batches?.length) {
        show(j.batches);
        setDelivered(
          dir,
          j.batches.map((b) => b.id),
        ); // printed first, then acked: if we die in between, the lease expires and the batch is offered again
        await fetch(p.url + '/ack', {
          method: 'POST',
          body: JSON.stringify({
            ids: j.batches.map((b) => b.id),
          }),
        }).catch(() => {});
        return;
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        await sleep(500);
      }
    }
  }
}
function cmdFrame() {
  const dir = projectDir(pos[1]);
  const t = Number(pos[2]);
  if (!pos[2] || isNaN(t)) {
    usage('frame needs <project> <t> (seconds)');
  }
  const reel = readReel(dir);
  if (!reel) {
    fail('no_reel', `no readable reel.json in ${dir}`);
  }
  if (typeof reel.src !== 'string') {
    fail('no_src', 'reel.json has no "src" video to take the frame from', [
      `Run \`${AXI} check ${dir}\``,
    ]);
  }
  const file = path.join(storageDir(dir), 'frames', `${t.toFixed(2)}.jpg`);
  fs.mkdirSync(path.dirname(file), {
    recursive: true,
  });
  const src = resolveProjectFile(dir, reel.src);
  if (!src) {
    fail('bad_src', 'src must stay inside the project');
  }
  try {
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-ss', String(t), '-i', src, '-frames:v', '1', file],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
  } catch (e) {
    fail(
      e.code === 'ENOENT' ? 'no_ffmpeg' : 'ffmpeg_failed',
      e.code === 'ENOENT' ? 'ffmpeg is not installed' : String(e.stderr || e.message).trim(),
    );
  }
  out(
    {
      frame: file,
      t,
    },
    ['Read the image to see what the note points at'],
  );
}
async function cmdExport() {
  const dir = projectDir(pos[1]);
  const p = player(dir);
  if (!p) {
    fail('no_player', `no player running for ${dir}`, [`Run \`${AXI} open ${dir}\``]);
  }
  let j = await fetch(p.url + '/export').then((r) => r.json());
  while (flags.has('--wait') && j.state === 'running') {
    await sleep(2000);
    j = await fetch(p.url + '/export').then((r) => r.json());
  }
  out(
    {
      state: j.state,
      pct: j.pct ?? null,
      out: j.out ? path.join(dir, j.out) : null,
      line: j.line ?? null,
    },
    j.state === 'idle'
      ? ['Ask the user to press Export MP4 in the player (live projects only)']
      : j.state === 'running'
        ? [`Run \`${AXI} export ${dir} --wait\` to wait for it`]
        : [],
  );
}
function cmdStop() {
  const all = readPlayers();
  const dirs = pos[1] ? [projectDir(pos[1])].filter((d) => all[d]) : Object.keys(all);
  if (!dirs.length) {
    return out({
      players: 'none running',
    });
  }
  for (const d of dirs) {
    try {
      process.kill(all[d].pid, 'SIGTERM');
    } catch {}
  }
  out(
    {
      stopped: dirs,
    },
    [`Run \`${AXI} open <project>\` to start one again`],
  );
}
function cmdHook() {
  const hook = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `node ${BIN}`,
            },
          ],
        },
      ],
    },
  };
  out(
    {
      paste_into: '~/.claude/settings.json (merge into "hooks")',
      snippet: JSON.stringify(hook),
    },
    ['This prints only; nothing was changed'],
  );
}
if (argv[0] === '--selftest') {
  try {
    const { selftest } = await import('./selftest.mjs');
    await selftest();
    console.log('selftest ok');
  } catch (e) {
    out({
      error: 'selftest',
      message: e.message,
    });
    process.exit(1);
  }
  process.exit(0);
}
if (!pos.length && flags.has('--help')) {
  out(
    {
      usage: `${AXI} <command> [args] [flags]`,
      commands: Object.values(COMMANDS).map((c) => ({
        usage: c.usage,
        about: c.about,
      })),
      flags: ['--help', '--full'],
    },
    [`Run \`${AXI}\` with no arguments for running players`],
  );
  process.exit(0);
}
if (!pos.length) {
  for (const f of flags) {
    usage(`unknown flag ${f}`);
  }
  cmdStatus();
  process.exit(0);
}
const cmd = COMMANDS[pos[0]];
if (!cmd) {
  usage(`unknown command "${pos[0]}"`);
}
const known = new Set(['--help', '--full', ...cmd.flags]);
for (const f of flags) {
  if (!known.has(f)) {
    usage(`unknown flag ${f} for ${pos[0]}`);
  }
}
if (flags.has('--help')) {
  out({
    usage: `${AXI} ${cmd.usage}`,
    about: cmd.about,
    flags: [...cmd.flags, '--full'],
  });
  process.exit(0);
}
await cmd.run();
process.exit(0);
