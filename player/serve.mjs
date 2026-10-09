#!/usr/bin/env node
// Motion OS player server. Serves the player page plus one project folder (reel.json, the video, assets/)
// on localhost and opens it in the browser. No dependencies.
//   node serve.mjs <project-dir> [--port 4321] [--no-open]
//   node serve.mjs --selftest
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {exec, spawn} from 'node:child_process';
import {addPlayer, removePlayer, readQueue, pushBatch, leaseQueue, ackQueue, appendTranscript, readTranscript, markTranscript, isWorking} from '../bin/store.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};

// "bytes=0-99" / "bytes=100-" / "bytes=-100" -> [start, end] inclusive, or null if unusable.
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start <= end && start < size ? [start, end] : null;
}

if (process.argv[2] === '--selftest') {
  const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
  eq(parseRange('bytes=0-99', 1000), [0, 99]);
  eq(parseRange('bytes=900-', 1000), [900, 999]);
  eq(parseRange('bytes=-100', 1000), [900, 999]);
  eq(parseRange('bytes=0-5000', 1000), [0, 999]);
  eq(parseRange('bytes=1000-', 1000), null);
  eq(parseRange('bytes=-', 1000), null);
  eq(parseRange(undefined, 1000), null);
  console.log('selftest ok');
  process.exit(0);
}

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, name === '--no-open' ? 1 : 2)[1] ?? true; };
const noOpen = flag('--no-open');
let port = Number(flag('--port') || process.env.PORT || 4321);
const dir = path.resolve(args[0] || '.');
const page = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
if (!fs.existsSync(path.join(dir, 'reel.json'))) { console.error(`Motion OS: no reel.json in ${dir}`); process.exit(1); }

// Export: reel.json "export": {"cwd": build folder, "cmd": shell command}. The command gets $PROPS (a JSON file with the
// user's edits), $RAW (temp render path), $OUT (final mp4 in <project>/exports/) and $PROJECT. One export at a time.
let job = {state: 'idle'};
function startExport(props) {
  const reel = JSON.parse(fs.readFileSync(path.join(dir, 'reel.json'), 'utf8')), ex = reel.export;
  if (!ex) return {state: 'error', line: 'This project has no "export" in reel.json.'};
  if (job.state === 'running') return job;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  fs.mkdirSync(path.join(dir, 'exports'), {recursive: true});
  const out = path.join(dir, 'exports', `${reel.id}-${stamp}.mp4`), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motionos-'));
  const env = {...process.env, PROJECT: dir, OUT: out, RAW: path.join(tmp, 'raw.mp4'), PROPS: path.join(tmp, 'props.json')};
  fs.writeFileSync(env.PROPS, JSON.stringify({...ex.props, ...props}));
  job = {state: 'running', pct: 0, line: 'Starting', out: path.relative(dir, out)};
  const p = spawn('sh', ['-c', ex.cmd], {cwd: ex.cwd || dir, env});
  const onData = (d) => {
    const text = String(d), m = [...text.matchAll(/(\d+)\/(\d+)/g)].pop();
    if (m && +m[2] > 0) job.pct = Math.min(99, Math.round(+m[1] / +m[2] * 100));
    const last = text.trim().split(/[\r\n]+/).pop(); if (last) job.line = last.slice(0, 200);
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('close', (code) => { job = code === 0 ? {...job, state: 'done', pct: 100} : {...job, state: 'error'}; fs.rmSync(tmp, {recursive: true, force: true}); });
  return job;
}

// Feedback from the player's Send, queued per project until `motion-os-axi poll` takes it. One waiting poll gets each
// batch on a 30 s lease; the batch is deleted only when that poll acks it, so a poll that dies mid-reply loses nothing.
const waiters = [];
function deliver(){
  while (waiters.length) {
    const res = waiters[0];
    if (res.writableEnded || res.destroyed) { waiters.shift(); continue; }
    const batches = leaseQueue(dir);
    if (!batches.length) return;
    markTranscript(dir, e => batches.some(b => b.id === e.id), 'picked');
    waiters.shift(); res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({batches}));
  }
}
setInterval(deliver, 5000).unref();   // re-offers batches whose lease ran out
// Only our own page (same port) may POST; other pages on localhost are other sites.
const sameOrigin = req => { const o = req.headers.origin; if (!o) return true; const m = /^http:\/\/(localhost|127\.0\.0\.1):(\d+)$/.exec(o); return !!m && Number(m[2]) === port; };
// The feedback endpoints change state, so a page on another site (or a DNS-rebinding hostname) must not reach them.
const hostOk = req => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');   // blocks DNS-rebinding hostnames
const localOnly = req => hostOk(req) && req.headers['sec-fetch-site'] !== 'cross-site' && sameOrigin(req);

// Reads a request body, refusing anything over 1 MB.
function readBody(req, res, done){
  let body = '', size = 0, big = false;
  req.on('data', c => { size += c.length; if (size > 1e6) big = true; else body += c; });
  req.on('end', () => big ? res.writeHead(413).end() : done(body));
}
const presence = () => waiters.some(r => !r.writableEnded && !r.destroyed) ? 'listening' : isWorking(readTranscript(dir)) ? 'working' : 'idle';

const server = http.createServer((req, res) => {
  let url; try { url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { return res.writeHead(400).end(); }   // e.g. "/%"
  if (url.includes('\0')) return res.writeHead(400).end();   // "/%00": fs would throw synchronously and take the server down
  // Every path needs a localhost Host (so a rebinding page can't read the page, files or .motion-os/). The endpoints also refuse
  // cross-site browser requests; the page itself may be opened from a link on another site.
  if (!hostOk(req)) return res.writeHead(403).end();
  if (['/feedback', '/poll', '/ack', '/export', '/reply', '/transcript'].includes(url) && !localOnly(req)) return res.writeHead(403).end();
  if (url === '/ack') return readBody(req, res, body => { try { ackQueue(dir, JSON.parse(body || '{}').ids || []); res.writeHead(200, {'Content-Type': 'application/json'}).end('{"ok":true}'); } catch { res.writeHead(400).end(); } });
  if (url === '/reply') return readBody(req, res, body => {
    let text = '', ids = null; try { const j = JSON.parse(body || '{}'); text = String(j.text || '').trim(); ids = Array.isArray(j.ids) ? j.ids : null; } catch {}
    if (!text) return res.writeHead(400).end();
    // with ids (from motion-os-axi poll --reply), close exactly those; without, every picked batch
    appendTranscript(dir, {role: 'agent', text}); markTranscript(dir, e => ids ? ids.includes(e.id) : e.status === 'picked', 'done');
    res.writeHead(200, {'Content-Type': 'application/json'}).end('{"ok":true}');
  });
  if (url === '/transcript') return res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({entries: readTranscript(dir), presence: presence(), waiting: readQueue(dir).length}));
  if (url === '/feedback') {
    const send = (code, j) => res.writeHead(code, {'Content-Type': 'application/json'}).end(JSON.stringify(j));
    if (req.method !== 'POST') return send(200, {waiting: readQueue(dir).length});
    return readBody(req, res, body => { try { const payload = JSON.parse(body || '{}'), b = pushBatch(dir, payload); appendTranscript(dir, {id: b.id, role: 'user', batch: payload, status: 'sent'}); send(200, {ok: true, id: b.id, waiting: readQueue(dir).length}); deliver(); } catch (e) { send(400, {ok: false, error: e.message}); } });
  }
  if (url === '/poll') {
    waiters.push(res);
    const ms = Math.min(Number(new URL(req.url, 'http://localhost').searchParams.get('ms')) || 25000, 25000);
    const t = setTimeout(() => { const i = waiters.indexOf(res); if (i >= 0) { waiters.splice(i, 1); res.writeHead(200, {'Content-Type': 'application/json'}).end('{"batches":[]}'); } }, ms);
    res.on('close', () => { clearTimeout(t); const i = waiters.indexOf(res); if (i >= 0) waiters.splice(i, 1); });
    return deliver();
  }
  if (url === '/export') {
    // Only our own page may start a render (blocks other websites posting to localhost).
    const send = (j) => res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(j));
    if (req.method !== 'POST') return send(job);
    let body = ''; req.on('data', (c) => body += c);
    return req.on('end', () => { try { send(startExport(JSON.parse(body || '{}'))); } catch (e) { send({state: 'error', line: e.message}); } });
  }
  let file = url === '/' ? page : path.resolve(dir, '.' + url);
  if (file !== page && !file.startsWith(dir + path.sep)) return res.writeHead(403).end('Forbidden');
  // Remotion's staticFile() paths point at the site root; serve them from public/.
  if (file !== page && !fs.existsSync(file) && fs.existsSync(path.join(dir, 'public', '.' + url))) file = path.join(dir, 'public', '.' + url);
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return res.writeHead(404).end('Not found');
    const head = {'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'};
    if (req.headers.range) {  // video seeking needs byte ranges
      const r = parseRange(req.headers.range, stat.size);
      if (!r) return res.writeHead(416, {'Content-Range': `bytes */${stat.size}`}).end();
      res.writeHead(206, {...head, 'Content-Range': `bytes ${r[0]}-${r[1]}/${stat.size}`, 'Content-Length': r[1] - r[0] + 1});
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(file, {start: r[0], end: r[1]}).pipe(res);
    }
    res.writeHead(200, {...head, 'Content-Length': stat.size});
    req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
  });
});

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  port += 1; server.listen(port, '127.0.0.1');  // try the next port
});
server.on('listening', () => {
  addPlayer(dir, port);
  const url = `http://localhost:${port}`;
  console.log(`Motion OS: ${url}  (project: ${dir})  Ctrl+C to stop`);
  if (!noOpen) exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} ${url}`);
});
server.listen(port, '127.0.0.1');
const bye = () => { removePlayer(dir); process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye); process.on('exit', () => removePlayer(dir));
