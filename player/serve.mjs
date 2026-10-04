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

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (url === '/export') {
    // Only our own page may start a render (blocks other websites posting to localhost).
    if (req.method === 'POST' && req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req.headers.origin)) return res.writeHead(403).end();
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
  const url = `http://localhost:${port}`;
  console.log(`Motion OS: ${url}  (project: ${dir})  Ctrl+C to stop`);
  if (!noOpen) exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} ${url}`);
});
server.listen(port, '127.0.0.1');
