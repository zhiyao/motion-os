import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createPlayerHandler} from '../player/server.mjs';
import {createExportController} from '../player/export.mjs';
import {insideProject, resolveProjectFile} from '../bin/project-files.mjs';
const playerRoot = fileURLToPath(new URL('../player/', import.meta.url));

test('file resolver uses public fallback and refuses paths outside the project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-files-'));
  try {
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(path.join(dir, 'public', 'v.mp4'), 'fallback');
    assert.equal(resolveProjectFile(dir, 'v.mp4'), path.join(dir, 'public', 'v.mp4'));
    fs.writeFileSync(path.join(dir, 'v.mp4'), 'root');
    assert.equal(resolveProjectFile(dir, 'v.mp4'), path.join(dir, 'v.mp4'));
    for (const name of ['../secret', '/etc/passwd', 'C:\\secret', '..\\secret', {}, '', 'a\0b']) assert.equal(insideProject(name), false);
    assert.equal(resolveProjectFile(dir, '../secret'), null);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('server serves app modules, ranges and bounded export requests', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-server-'));
  fs.writeFileSync(path.join(dir, 'reel.json'), '{}');
  fs.writeFileSync(path.join(dir, 'v.mp4'), '0123456789');
  let port;
  const routes = createPlayerHandler(dir, {page: path.join(playerRoot, 'index.html'), getPort: () => port});
  const server = http.createServer(routes.handler);
  t.after(async () => { routes.close(); await new Promise(r => server.close(r)); fs.rmSync(dir, {recursive: true, force: true}); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  for (const name of ['app.mjs', 'model.mjs', 'browser-selftest.mjs']) {
    const r = await fetch(`${base}/_player/${name}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.ok((await r.text()).length > 0);
  }
  const range = await fetch(`${base}/v.mp4`, {headers: {range: 'bytes=2-5'}});
  assert.equal(range.status, 206); assert.equal(await range.text(), '2345');
  assert.equal((await fetch(`${base}/v.mp4`, {headers: {range: 'bytes=20-'}})).status, 416);
  assert.equal((await fetch(`${base}/export`, {method: 'POST', body: 'x'.repeat(1000001)})).status, 413);
  assert.equal((await fetch(`${base}/export`, {method: 'POST', body: '{}', headers: {origin: 'http://localhost:1'}})).status, 403);
  assert.equal((await fetch(`${base}/_player/%2e%2e%2fbin/store.mjs`)).status, 403);
  const feedback = await (await fetch(`${base}/feedback`, {method: 'POST', body: JSON.stringify({version: 1, messages: ['Hi']})})).json();
  assert.equal(feedback.ok, true);
  const batch = await (await fetch(`${base}/poll?ms=100`)).json();
  assert.equal(batch.batches[0].id, feedback.id);
  await fetch(`${base}/ack`, {method: 'POST', body: JSON.stringify({ids: [feedback.id]})});
  assert.equal((await (await fetch(`${base}/feedback`)).json()).waiting, 0);
});

test('export handles spawn failure and leaves no temporary render folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-export-'));
  const tempDirs = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('motion-os-axi-'));
  const before = new Set(tempDirs());
  try {
    fs.writeFileSync(path.join(dir, 'reel.json'), JSON.stringify({id: 'test', export: {cwd: 'missing', cmd: 'true'}}));
    const controller = createExportController(dir);
    assert.equal(controller.start({}).state, 'running');
    for (let n = 0; n < 100 && controller.status().state === 'running'; n++) await new Promise(r => setTimeout(r, 10));
    assert.equal(controller.status().state, 'error');
    assert.match(controller.status().line, /ENOENT/);
    // ChildProcess close follows error and performs cleanup.
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(tempDirs().filter(n => !before.has(n)), []);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('export runs relative to project, merges props and preserves previous outputs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-render-'));
  try {
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'build', 'render.mjs'), "import fs from 'node:fs'; fs.writeFileSync(process.env.OUT, fs.readFileSync(process.env.PROPS)); console.log('10/10');");
    fs.writeFileSync(path.join(dir, 'reel.json'), JSON.stringify({id: 'test', export: {cwd: 'build', cmd: `"${process.execPath}" render.mjs`, props: {default: true, value: 1}}}));
    const controller = createExportController(dir);
    const wait = async () => {
      for (let n = 0; n < 200 && controller.status().state === 'running'; n++) await new Promise(r => setTimeout(r, 10));
      assert.equal(controller.status().state, 'done'); assert.equal(controller.status().pct, 100);
      return controller.status().out;
    };
    const firstJob = controller.start({value: 2});
    assert.equal(controller.start({value: 3}), firstJob, 'a running render is reused');
    const first = await wait();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, first))), {default: true, value: 2});
    controller.start({value: 3}); const second = await wait();
    assert.notEqual(first, second);
    assert.equal(fs.existsSync(path.join(dir, first)), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, second))).value, 3);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
