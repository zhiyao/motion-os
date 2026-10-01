#!/usr/bin/env node
// Motion OS player server. Serves the player page plus one project folder (reel.json, the video, assets/)
// on localhost and opens it in the browser. No dependencies.
//   node serve.mjs <project-dir> [--port 4321] [--no-open]
//   node serve.mjs --selftest
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exec} from 'node:child_process';

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

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = url === '/' ? page : path.resolve(dir, '.' + url);
  if (file !== page && !file.startsWith(dir + path.sep)) return res.writeHead(403).end('Forbidden');
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
