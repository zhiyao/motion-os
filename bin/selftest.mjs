// Checks for `motion-os-axi --selftest`. Each task adds its own section.
import { toon, val, trunc } from './toon.mjs';
import { checkReelData } from './check.mjs';
import { formatFeedback } from './format.mjs';
import {
  readPlayers,
  addPlayer,
  removePlayer,
  readQueue,
  pushBatch,
  leaseQueue,
  ackQueue,
  appendTranscript,
  readTranscript,
  markTranscript,
  isWorking,
  setDelivered,
  takeDelivered,
} from './store.mjs';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }
};
export async function selftest() {
  // toon
  eq(val('plain words'), 'plain words', 'bare string');
  eq(
    [val('a,b'), val('x: y'), val('say "hi"'), val('two\nlines'), val(''), val(' pad')],
    ['"a,b"', '"x: y"', '"say \\"hi\\""', '"two\\nlines"', '""', '" pad"'],
    'quoted strings',
  );
  eq(
    [val(3), val(1.5), val(true), val(null), val(undefined)],
    ['3', '1.5', 'true', 'null', 'null'],
    'scalars',
  );
  eq(
    toon({
      a: 1,
      b: 'x',
    }),
    'a: 1\nb: x',
    'scalars object',
  );
  eq(
    toon({
      l: ['x', 'y,z'],
    }),
    'l[2]: x,"y,z"',
    'scalar list',
  );
  eq(
    toon({
      r: [
        {
          id: 1,
          t: 'a',
        },
        {
          id: 2,
          t: 'b, c',
          more: 9,
        },
      ],
    }),
    'r[2]{id,t,more}:\n  1,a,null\n  2,"b, c",9',
    'object rows use the union of keys',
  );
  eq(
    toon({
      r: [],
    }),
    'r[0]:',
    'empty list',
  );
  eq(trunc('x'.repeat(130), false), 'x'.repeat(120) + '…(+10 chars)', 'truncates');
  eq(trunc('x'.repeat(130), true).length, 130, '--full keeps everything');

  // check
  const good = () => ({
    id: 'x',
    version: 1,
    src: 'v.mp4',
    fps: 30,
    duration: 10,
    assets: [
      {
        id: 'assets/a.png',
      },
    ],
    scenes: [
      {
        id: 'S1',
        t: [0, 4],
        els: [
          {
            id: 'a',
            t: [0, 4],
            box: [10, 10, 50, 50],
            props: {
              img: {
                type: 'media',
                v: 'assets/a.png',
              },
            },
          },
        ],
      },
      {
        id: 'S2',
        t: [4, 10],
        els: [
          {
            id: 'b',
            t: [5, 9],
            box: null,
            props: {},
          },
        ],
      },
    ],
  });
  const msgs = (r, o) =>
    checkReelData(r, {
      exists: () => true,
      ...o,
    }).map((p) => `${p.level} ${p.where}: ${p.message}`);
  eq(msgs(good()), [], 'good reel has no problems');
  let r = good();
  delete r.fps;
  eq(msgs(r), ['error reel: missing "fps"'], 'missing field');
  r = good();
  r.scenes[0].t = [0.5, 4];
  eq(msgs(r)[0], 'error S1: starts at 0.5s, not 0', 'first scene start');
  r = good();
  r.scenes[1].t = [5, 10];
  eq(msgs(r)[0], 'error S2: gap after S1 (4s to 5s)', 'gap');
  r = good();
  r.scenes[1].t = [3, 10];
  eq(msgs(r)[0], 'error S2: overlaps S1 (starts 3s, S1 ends 4s)', 'overlap');
  r = good();
  r.duration = 12;
  eq(msgs(r), ['error S2: ends at 10s but duration is 12s'], 'end vs duration');
  r = good();
  r.scenes[1].els[0].id = 'a';
  eq(msgs(r), ['error a: duplicate id'], 'duplicate id');
  r = good();
  r.scenes[0].els[0].box = [60, 10, 50, 50];
  eq(msgs(r), ['error a: box [60,10,50,50] is not [x, y, w, h] inside 0-100'], 'box outside');
  r = good();
  r.scenes[1].els[0].t = [3, 9];
  eq(msgs(r), ['error b: time 3-9s is outside S2 (4-10s)'], 'element time outside scene');
  r = good();
  eq(
    msgs(r, {
      exists: (p) => p !== 'assets/a.png',
    }),
    ['error a: img: file assets/a.png not found', 'error assets: assets/a.png not found'],
    'missing file',
  );
  r = good();
  eq(
    msgs(r, {
      mp4Duration: 10.3,
    }),
    ['warn reel: duration 10s but v.mp4 is 10.30s'],
    'mp4 duration',
  );
  r = good();
  r.scenes[0].els[0].keys = [
    {
      t: 1,
      box: [10, 10, 50, 50],
    },
    {
      t: 3,
      box: [0, -40, 80, 140],
    },
  ];
  eq(msgs(r), [], 'valid keys (boxes may leave the frame)');
  r = good();
  r.scenes[0].els[0].keys = [
    {
      t: 3,
      box: [10, 10, 50, 50],
    },
    {
      t: 1,
      box: [10, 10, 50, 50],
    },
  ];
  eq(msgs(r), ['error a: keys are not in time order'], 'unsorted keys');
  r = good();
  r.scenes[0].els[0].keys = [1, 2, 3];
  eq(msgs(r), ['error a: keys must be 1 or 2 {t, box: [x, y, w, h]} entries'], 'bad keys');
  r = good();
  r.scenes[0].els[0].keys = [
    {
      t: 9,
      box: [10, 10, 50, 50],
    },
  ];
  eq(msgs(r), ['error a: a keyframe is outside its time 0-4s'], 'key outside the element time');
  r = good();
  r.scenes[1].els[0].keys = [
    {
      t: 5,
      box: [10, 10, 50, 50],
    },
  ];
  eq(msgs(r), ['error b: keys need a box'], 'keys on an element without a box');
  r = good();
  delete r.scenes[1].t;
  eq(
    msgs(r).includes('error S2: t must be [start, end] in seconds'),
    true,
    'scene without t is reported, not thrown',
  );
  r = good();
  r.assets = [
    {
      name: 'x',
    },
  ];
  eq(msgs(r), ['error assets: an asset has no id'], 'asset without id');
  r = good();
  r.scenes[0].els[0].props = {
    img: null,
  };
  eq(msgs(r), ['error a: prop img is empty'], 'null prop');
  eq(
    checkReelData(null).map((p) => p.message),
    ['reel.json must be an object'],
    'a non-object reel is reported',
  );
  r = good();
  r.scenes = [];
  eq(msgs(r), ['error reel: needs at least one scene'], 'empty scenes');
  r = good();
  delete r.scenes[1].els;
  eq(msgs(r), ['error S2: els must be an array'], 'scene without els');
  r = good();
  delete r.scenes[1].id;
  eq(msgs(r).includes('error scene 2: missing id'), true, 'scene without id');
  r = good();
  delete r.scenes[1].els[0].id;
  eq(msgs(r), ['error S2: an element has no id'], 'element without id');
  r = good();
  delete r.scenes[1].els[0].t;
  eq(msgs(r), ['error b: t must be [start, end] in seconds'], 'element without t');
  r = good();
  r.src = '../v.mp4';
  eq(
    msgs(r),
    ['error reel: src ../v.mp4 is outside the project'],
    'paths may not leave the project',
  );
  r = good();
  r.scenes[1].t = [10, 4];
  eq(
    msgs(r).includes('error S2: t must be [start, end] in seconds'),
    true,
    'a reversed scene span is reported',
  );
  r = good();
  r.scenes[1].els[0].t = [6, 6];
  eq(
    msgs(r),
    ['error b: t must be [start, end] in seconds'],
    'a zero-length element span is reported',
  );
  r = good();
  delete r.scenes[1].els[0].props;
  eq(msgs(r), ['error b: props must be an object'], 'an element without props is reported');
  r = good();
  r.live = 'live.js';
  r.export = {};
  eq(
    msgs(r, {
      exists: (p) => p !== 'live.js',
    }),
    ['warn reel: live bundle live.js not found', 'warn reel: export has no cmd'],
    'live and export',
  );

  // store: registry and queue, in a temp home and project
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-os-axi-test-'));
  const proj = path.join(tmp, 'proj');
  process.env.MOTION_OS_AXI_HOME = path.join(tmp, 'home');
  fs.mkdirSync(proj);
  addPlayer(proj, 5555);
  eq(Object.keys(readPlayers()), [proj], 'registry add');
  eq(readPlayers()[proj].pid, process.pid, 'registry pid is ours');
  fs.writeFileSync(
    path.join(process.env.MOTION_OS_AXI_HOME, 'players', 'dead.json'),
    JSON.stringify({
      dir: '/gone',
      port: 1,
      pid: 999999,
      started: 0,
    }),
  );
  eq(Object.keys(readPlayers()), [proj], 'dead pids are dropped');
  removePlayer(proj);
  eq(readPlayers(), {}, 'registry remove');
  eq(readQueue(proj), [], 'empty queue');
  pushBatch(proj, {
    a: 1,
  });
  pushBatch(proj, {
    a: 2,
  });
  const leased = leaseQueue(proj, 80);
  eq(
    leased.map((b) => b.payload.a),
    [1, 2],
    'lease returns batches in order',
  );
  eq(leaseQueue(proj, 80), [], 'leased batches are not handed out twice');
  eq(readQueue(proj).length, 2, 'leased batches stay queued until acked');
  await new Promise((r) => setTimeout(r, 120));
  eq(leaseQueue(proj, 80).length, 2, 'an unacked lease expires and is handed out again');
  ackQueue(
    proj,
    leased.map((b) => b.id),
  );
  eq(readQueue(proj), [], 'ack removes them');
  pushBatch(proj, {
    version: 1,
    a: 'old',
  });
  pushBatch(proj, {
    version: 2,
    a: 'new',
  });
  const l1 = leaseQueue(proj);
  const l2 = leaseQueue(proj);
  eq(
    [l1.map((b) => b.payload.a), l2.map((b) => b.payload.a)],
    [['old'], ['new']],
    'batches from different versions are delivered separately',
  );
  ackQueue(
    proj,
    [...l1, ...l2].map((b) => b.id),
  );

  // transcript
  const u = appendTranscript(proj, {
    role: 'user',
    batch: {
      notes: [1],
    },
    status: 'sent',
  });
  appendTranscript(proj, {
    role: 'agent',
    text: 'hi',
  });
  eq(
    readTranscript(proj).map((e) => [e.role, e.status ?? e.text]),
    [
      ['user', 'sent'],
      ['agent', 'hi'],
    ],
    'transcript append',
  );
  eq(
    markTranscript(proj, (e) => e.id === u.id, 'picked'),
    1,
    'mark one user entry',
  );
  eq(
    markTranscript(proj, () => true, 'done'),
    1,
    'agent entries are never marked',
  );
  eq(readTranscript(proj)[0].status, 'done', 'status stored');
  // poll --reply with no player running records the reply in the transcript file
  const cli = fileURLToPath(new URL('./motion-os-axi.mjs', import.meta.url));
  try {
    execFileSync(
      process.execPath,
      [cli, 'poll', proj, '--reply', 'Done: all good', '--timeout', '1'],
      {
        env: process.env,
        stdio: 'pipe',
      },
    );
  } catch {}
  eq(readTranscript(proj).at(-1).text, 'Done: all good', 'reply recorded without a player');
  let usageExit = 0;
  try {
    execFileSync(process.execPath, [cli, 'poll', proj, '--reply'], {
      env: process.env,
      stdio: 'pipe',
    });
  } catch (e) {
    usageExit = e.status;
  }
  eq(usageExit, 2, '--reply needs text');
  // --reply closes only what the last poll delivered; a no-player poll marks its batches picked; old picks go stale
  const orphan = appendTranscript(proj, {
    role: 'user',
    batch: {},
    status: 'picked',
    pickedAt: Date.now(),
  });
  const B = pushBatch(proj, {
    title: 'Demo',
    version: 1,
    notes: [
      {
        n: 1,
        t: 1,
        text: 'x',
      },
    ],
  });
  appendTranscript(proj, {
    id: B.id,
    role: 'user',
    batch: B.payload,
    status: 'sent',
  });
  execFileSync(process.execPath, [cli, 'poll', proj, '--timeout', '1'], {
    env: process.env,
    stdio: 'pipe',
  });
  const st = (id) => readTranscript(proj).find((e) => e.id === id).status;
  eq(st(B.id), 'picked', 'a poll without a player marks its batch picked');
  try {
    execFileSync(process.execPath, [cli, 'poll', proj, '--reply', 'ok', '--timeout', '1'], {
      env: process.env,
      stdio: 'pipe',
    });
  } catch {} // exits 1 after replying: no player to wait on
  eq(
    [st(orphan.id), st(B.id)],
    ['picked', 'done'],
    'a reply closes only the batch that poll delivered',
  );
  eq(
    [
      isWorking([
        {
          role: 'user',
          status: 'picked',
          pickedAt: Date.now(),
        },
      ]),
      isWorking([
        {
          role: 'user',
          status: 'picked',
          pickedAt: Date.now() - 31 * 60e3,
        },
      ]),
    ],
    [true, false],
    'a pick older than 30 minutes is not "working"',
  );
  setDelivered(proj, ['a']);
  setDelivered(proj, ['b', 'a']);
  eq(takeDelivered(proj), ['a', 'b'], 'delivered ids accumulate across polls');
  // a failed --reply keeps the delivered ids for the retry
  const proj2 = path.join(tmp, 'proj2');
  fs.mkdirSync(proj2);
  setDelivered(proj2, ['x']);
  addPlayer(proj2, 1); // port 1: nothing listening
  try {
    execFileSync(process.execPath, [cli, 'poll', proj2, '--reply', 'hi', '--timeout', '1'], {
      env: process.env,
      stdio: 'pipe',
    });
  } catch {}
  removePlayer(proj2);
  eq(takeDelivered(proj2), ['x'], 'a failed reply keeps the ids');
  const proj3 = path.join(tmp, 'proj3');
  fs.mkdirSync(proj3);
  fs.writeFileSync(
    path.join(proj3, 'reel.json'),
    JSON.stringify({
      id: 'x',
    }),
  );
  let out3 = '';
  try {
    execFileSync(process.execPath, [cli, 'frame', proj3, '1'], {
      env: process.env,
      stdio: 'pipe',
    });
  } catch (e) {
    out3 = String(e.stdout);
  }
  eq(out3.startsWith('error: no_src'), true, 'frame without src is a TOON error');
  for (const bad of [['--timeout', 'abc'], ['--timeout']]) {
    let code = 0;
    try {
      execFileSync(process.execPath, [cli, 'poll', proj, ...bad], {
        env: process.env,
        stdio: 'pipe',
      });
    } catch (e) {
      code = e.status;
    }
    eq(code, 2, `poll ${bad.join(' ')} is a usage error`);
  }
  const proj4 = path.join(tmp, 'proj4');
  fs.mkdirSync(path.join(proj4, 'public'), {
    recursive: true,
  });
  fs.copyFileSync(
    fileURLToPath(new URL('../examples/qbot-tag/video.mp4', import.meta.url)),
    path.join(proj4, 'public', 'v.mp4'),
  );
  fs.writeFileSync(
    path.join(proj4, 'reel.json'),
    JSON.stringify({
      id: 'p4',
      src: 'v.mp4',
    }),
  );
  let out4 = '';
  try {
    out4 = execFileSync(process.execPath, [cli, 'frame', proj4, '1'], {
      env: process.env,
      stdio: 'pipe',
    }).toString();
  } catch (e) {
    out4 = String(e.stdout);
  }
  eq(out4.startsWith('frame: '), true, 'frame finds a src that lives in public/');
  fs.rmSync(path.join(proj, '.motion-os-axi', 'transcript.json'), {
    force: true,
  }); // the server checks below start from an empty transcript

  // registry: players starting at the same moment must not overwrite each other
  const storeUrl = new URL('./store.mjs', import.meta.url).href;
  const kids = [...Array(8)].map((_, i) =>
    spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {addPlayer} from '${storeUrl}'; addPlayer(${JSON.stringify(path.join(tmp, 'p' + i))}, ${6000 + i}); setTimeout(() => {}, 4000);`,
      ],
      {
        env: process.env,
        stdio: 'ignore',
      },
    ),
  );
  await new Promise((r) => setTimeout(r, 1500));
  eq(
    Object.keys(readPlayers()).filter((d) => d.includes(tmp)).length,
    8,
    'eight players starting together all register',
  );
  kids.forEach((k) => k.kill());

  // server: /feedback and /poll, one batch to exactly one of two waiting polls
  fs.copyFileSync(
    fileURLToPath(new URL('../examples/qbot-tag/reel.json', import.meta.url)),
    path.join(proj, 'reel.json'),
  );
  let serverOutput = '';
  const srv = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../player/serve.mjs', import.meta.url)),
      proj,
      '--no-open',
      '--port',
      '4490',
    ],
    {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  srv.stdout.on('data', (d) => (serverOutput += d));
  srv.stderr.on('data', (d) => (serverOutput += d));
  try {
    for (let i = 0; i < 50 && !readPlayers()[proj]; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const registered = readPlayers()[proj];
    if (!registered) {
      throw new Error(
        `test server failed to start: ${serverOutput.trim() || 'no registry entry after 5 seconds'}`,
      );
    }
    const base = `http://localhost:${registered.port}`;
    eq((await (await fetch(base + '/feedback')).json()).waiting, 0, 'nothing waiting');
    const p1 = fetch(base + '/poll').then((r) => r.json());
    const p2 = fetch(base + '/poll').then((r) => r.json());
    await new Promise((r) => setTimeout(r, 200));
    const posted = await (
      await fetch(base + '/feedback', {
        method: 'POST',
        headers: {
          origin: base,
        },
        body: JSON.stringify({
          hello: 1,
        }),
      })
    ).json();
    eq(posted.ok, true, 'feedback accepted');
    const first = await Promise.race([
      p1.then((j) => ((j.who = 1), j)),
      p2.then((j) => ((j.who = 2), j)),
    ]);
    const other = first.who === 1 ? p2 : p1;
    eq(
      first.batches.map((b) => b.payload.hello),
      [1],
      'one poll gets the batch',
    );
    const t0 = Date.now();
    const again = await (await fetch(base + '/poll?ms=300')).json();
    eq(
      [again.batches.length, Date.now() - t0 < 2000],
      [0, true],
      'a leased batch is not given to another poll; ms bounds the wait',
    );
    eq((await (await fetch(base + '/feedback')).json()).waiting, 1, 'unacked batch stays queued');
    await fetch(base + '/ack', {
      method: 'POST',
      headers: {
        origin: base,
      },
      body: JSON.stringify({
        ids: first.batches.map((b) => b.id),
      }),
    });
    eq((await (await fetch(base + '/feedback')).json()).waiting, 0, 'acked batch left the queue');
    const raw = (headers, p = '/poll?ms=100') =>
      new Promise((r) =>
        http
          .get(
            {
              host: '127.0.0.1',
              port: Number(new URL(base).port),
              path: p,
              headers,
            },
            (res) => {
              res.resume();
              r(res.statusCode);
            },
          )
          .on('error', (e) => r(e.code)),
      );
    eq(
      await raw({
        host: 'evil.example',
      }),
      403,
      'poll refuses a foreign Host (DNS rebinding)',
    );
    eq(
      await raw({
        'sec-fetch-site': 'cross-site',
      }),
      403,
      'poll refuses cross-site browser requests',
    );
    // transcript and presence
    const tr = async () => (await fetch(base + '/transcript')).json();
    let T = await tr();
    eq(
      T.entries.map((e) => [e.role, e.status]),
      [['user', 'picked']],
      'sent batch is in the transcript, picked',
    );
    eq(T.presence, 'listening', 'a held poll means listening');
    await fetch(base + '/reply', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Done: changed the title',
      }),
    });
    T = await tr();
    eq(
      T.entries.map((e) => [e.role, e.status ?? e.text]),
      [
        ['user', 'done'],
        ['agent', 'Done: changed the title'],
      ],
      'reply lands and closes the batch',
    );
    eq(
      (
        await fetch(base + '/reply', {
          method: 'POST',
          body: '{"text":""}',
        })
      ).status,
      400,
      'empty reply refused',
    );
    await fetch(base + '/feedback', {
      method: 'POST',
      headers: {
        origin: base,
      },
      body: JSON.stringify({
        hello: 2,
      }),
    });
    const got = await other; // the still-waiting poll takes it
    eq(
      [got.batches[0].payload.hello, (await tr()).presence],
      [2, 'working'],
      'picked with nobody polling means working',
    );
    await fetch(base + '/ack', {
      method: 'POST',
      body: JSON.stringify({
        ids: got.batches.map((b) => b.id),
      }),
    });
    eq(
      (
        await fetch(base + '/feedback', {
          method: 'POST',
          headers: {
            origin: base,
          },
          body: 'x'.repeat(1100000),
        })
      ).status,
      413,
      'oversized body refused',
    );
    eq(
      await raw(
        {
          host: 'evil.example',
        },
        '/transcript',
      ),
      403,
      'transcript is local-only',
    );
    eq(
      [
        await raw(
          {
            host: 'evil.example',
          },
          '/.motion-os-axi/inbox.json',
        ),
        await raw(
          {
            host: 'evil.example',
          },
          '/reel.json',
        ),
      ],
      [403, 403],
      'every path refuses a foreign Host',
    );
    eq((await fetch(base + '/reel.json')).status, 200, 'the player still loads its files');
    eq(
      (
        await fetch(base + '/feedback', {
          method: 'POST',
          headers: {
            origin: 'http://localhost:1',
          },
          body: '{}',
        })
      ).status,
      403,
      'a page on another localhost port is refused',
    );
    eq(
      [
        await raw(
          {
            'sec-fetch-site': 'cross-site',
          },
          '/',
        ),
        await raw(
          {
            'sec-fetch-site': 'cross-site',
          },
          '/feedback',
        ),
      ],
      [200, 403],
      'a link from another site opens the page; endpoints stay local',
    );
    eq(
      [await raw({}, '/%'), (await fetch(base + '/reel.json')).status],
      [400, 200],
      'a malformed path is a 400 and the server stays up',
    );
    eq(
      [await raw({}, '/%00'), (await fetch(base + '/reel.json')).status],
      [400, 200],
      'a NUL in the path is a 400 and the server stays up',
    );
    eq(
      (
        await fetch(base + '/feedback', {
          method: 'POST',
          headers: {
            origin: 'https://evil.example',
          },
          body: '{}',
        })
      ).status,
      403,
      'other origins refused',
    );
  } finally {
    srv.kill();
  }
  await new Promise((r) => setTimeout(r, 300));
  eq(readPlayers()[proj], undefined, 'server removes itself on exit');
  fs.rmSync(tmp, {
    recursive: true,
    force: true,
  });

  // format: batches -> poll output, merged in order
  const fb = (v, extra) => ({
    payload: {
      title: 'Demo',
      id: 'demo',
      version: v,
      edits: [],
      notes: [],
      trims: [],
      links: [],
      scenes: [
        {
          id: 'S1',
          name: 'Intro',
          status: 'review',
        },
      ],
      ...extra,
    },
  });
  const f1 = formatFeedback(
    [
      fb(2, {
        edits: [
          {
            t: 1.5,
            scene: 'S1',
            element: 'Title',
            field: 'Text',
            from: 'Hi',
            to: 'Hello, world',
            src: 'src/A.tsx:3',
          },
        ],
      }),
      fb(2, {
        notes: [
          {
            n: 1,
            t: 3.2,
            scene: 'S1 Intro',
            x: 40,
            y: 50,
            on: 'Title',
            src: '',
            text: 'x'.repeat(130),
          },
        ],
        links: ['https://a.example/f.png'],
      }),
    ],
    {
      full: false,
    },
  );
  eq(
    [f1.feedback, f1.counts],
    ['Demo v2 → set version 3', 'edits=1 notes=1 trims=0 links=1 messages=0'],
    'header and counts',
  );
  eq(f1.edits[0].to, 'Hello, world', 'edit row');
  eq(f1.notes[0].text.endsWith('…(+10 chars)'), true, 'note text truncated');
  eq(
    formatFeedback(
      [
        fb(2, {
          notes: [
            {
              n: 1,
              t: 1,
              text: 'x'.repeat(130),
            },
          ],
        }),
      ],
      {
        full: true,
      },
    ).notes[0].text.length,
    130,
    '--full',
  );
  eq('trims' in f1, false, 'empty sections are left out');
  const fm = formatFeedback(
    [
      fb(2, {
        messages: ['make it faster', 'x'.repeat(130)],
      }),
    ],
    {
      full: false,
    },
  );
  eq(
    [fm.counts, fm.messages[0], fm.messages[1].endsWith('…(+10 chars)')],
    ['edits=0 notes=0 trims=0 links=0 messages=2', 'make it faster', true],
    'messages in poll output',
  );
}
