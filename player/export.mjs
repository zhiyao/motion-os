import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

// One render per project. The configured command receives PROJECT, OUT, RAW and PROPS.
export function createExportController(dir) {
  let job = {state: 'idle'};

  function start(props) {
    if (job.state === 'running') return job;
    const reel = JSON.parse(fs.readFileSync(path.join(dir, 'reel.json'), 'utf8'));
    const ex = reel.export;
    if (!ex) return {state: 'error', line: 'This project has no "export" in reel.json.'};
    if (typeof ex.cmd !== 'string' || !ex.cmd.trim()) return {state: 'error', line: 'Export needs a shell command.'};
    const stamp = new Date().toISOString().slice(0, 23).replace(/[-:]/g, '').replace('T', '-');
    fs.mkdirSync(path.join(dir, 'exports'), {recursive: true});
    const out = path.join(dir, 'exports', `${path.basename(String(reel.id))}-${stamp}-${crypto.randomBytes(3).toString('hex')}.mp4`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-os-axi-'));
    const env = {...process.env, PROJECT: dir, OUT: out, RAW: path.join(tmp, 'raw.mp4'), PROPS: path.join(tmp, 'props.json')};
    const current = {state: 'running', pct: 0, line: 'Starting', out: path.relative(dir, out)};
    job = current;
    let settled = false;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      current.state = code === 0 && !error ? 'done' : 'error';
      if (current.state === 'done') current.pct = 100;
      if (error) current.line = error.message;
      fs.rmSync(tmp, {recursive: true, force: true});
    };
    try {
      fs.writeFileSync(env.PROPS, JSON.stringify({...ex.props, ...props}));
      const child = spawn('sh', ['-c', ex.cmd], {cwd: ex.cwd ? path.resolve(dir, ex.cwd) : dir, env});
      const onData = data => {
        const text = String(data), match = [...text.matchAll(/(\d+)\/(\d+)/g)].pop();
        if (match && +match[2] > 0) current.pct = Math.min(99, Math.round(+match[1] / +match[2] * 100));
        const line = text.trim().split(/[\r\n]+/).pop();
        if (line) current.line = line.slice(0, 200);
      };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('error', error => finish(null, error));
      child.on('close', code => finish(code));
    } catch (error) { finish(null, error); }
    return current;
  }
  return {start, status: () => job};
}
