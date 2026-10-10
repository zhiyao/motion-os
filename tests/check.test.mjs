import test from 'node:test';
import assert from 'node:assert/strict';
import {checkReelData, checkReel} from '../bin/check.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const reel = () => ({id: 'demo', version: 1, src: 'video.mp4', fps: 30, duration: 2, scenes: [{id: 'S1', t: [0, 2], els: []}]});
for (const [field, value] of [['src', 42], ['fps', 0], ['fps', -30], ['fps', Infinity], ['duration', '2'], ['version', '1'], ['id', ''], ['scenes', {}], ['assets', {}], ['live', {}], ['export', []]]) {
  test(`reports invalid ${field}: ${JSON.stringify(value)}`, () => {
    const problems = checkReelData({...reel(), [field]: value});
    assert.ok(problems.some(p => p.level === 'error'), JSON.stringify(problems));
  });
}
test('checkReel reports malformed src without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-check-'));
  try {
    fs.writeFileSync(path.join(dir, 'reel.json'), JSON.stringify({...reel(), src: {}}));
    assert.ok(checkReel(dir).problems.some(p => p.level === 'error'));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
test('keyframes require finite times and coordinates, but may leave the frame', () => {
  const r = reel();
  const e = {id: 'a', t: [0, 2], props: {}, box: [0, 0, 10, 10], keys: [{t: 1, box: [0, -40, 80, 140]}]};
  r.scenes[0].els.push(e);
  assert.deepEqual(checkReelData(r), []);
  e.keys[0].t = NaN;
  assert.ok(checkReelData(r).some(p => p.level === 'error'));
  e.keys[0].t = 1; e.keys[0].box[0] = Infinity;
  assert.ok(checkReelData(r).some(p => p.level === 'error'));
});
