#!/usr/bin/env node
// Dependency-free local player. node player/serve.mjs <project> [--port 4321] [--no-open]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { addPlayer, removePlayer } from '../bin/store.mjs';
import { createPlayerHandler } from './server.mjs';
import { parseRange } from './http.mjs';
export { parseRange } from './http.mjs';
if (process.argv[2] === '--selftest') {
  const eq = (a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    }
  };
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
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : (args.splice(i, name === '--no-open' ? 1 : 2)[1] ?? true);
};
const noOpen = flag('--no-open');
let port = Number(flag('--port') || process.env.PORT || 4321);
const dir = path.resolve(args[0] || '.');
const page = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
if (!fs.existsSync(path.join(dir, 'reel.json'))) {
  console.error(`Motion OS AXI: no reel.json in ${dir}`);
  process.exit(1);
}
const routes = createPlayerHandler(dir, {
  page,
  getPort: () => port,
});
const server = http.createServer(routes.handler);
server.on('close', routes.close);
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') {
    throw e;
  }
  port += 1;
  server.listen(port, '127.0.0.1'); // try the next port
});
server.on('listening', () => {
  addPlayer(dir, port);
  const url = `http://localhost:${port}`;
  console.log(`Motion OS AXI: ${url}  (project: ${dir})  Ctrl+C to stop`);
  if (!noOpen) {
    if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', url]);
    } else {
      execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
    }
  }
});
server.listen(port, '127.0.0.1');
const bye = () => {
  removePlayer(dir);
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
process.on('exit', () => removePlayer(dir));
