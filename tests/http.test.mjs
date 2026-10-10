import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readBody, parseRange } from '../player/http.mjs';
test('body reader preserves UTF-8 split across network chunks', async () => {
  const req = new PassThrough();
  const bytes = Buffer.from('{"text":"你好"}');
  const body = new Promise((resolve) =>
    readBody(
      req,
      {
        writeHead() {
          throw new Error('unexpected rejection');
        },
      },
      resolve,
    ),
  );
  req.write(bytes.subarray(0, 10));
  req.end(bytes.subarray(10));
  assert.equal(await body, bytes.toString('utf8'));
});
test('body reader rejects oversized input without calling its callback', async () => {
  const req = new PassThrough();
  let status;
  let called = false;
  const done = new Promise((resolve) =>
    readBody(
      req,
      {
        writeHead(code) {
          status = code;
          return this;
        },
        end: resolve,
      },
      () => {
        called = true;
      },
    ),
  );
  req.end(Buffer.alloc(1000001));
  await done;
  assert.equal(status, 413);
  assert.equal(called, false);
});
test('ranges support bounded, open and suffix forms and reject invalid offsets', () => {
  assert.deepEqual(parseRange('bytes=2-4', 10), [2, 4]);
  assert.deepEqual(parseRange('bytes=8-', 10), [8, 9]);
  assert.deepEqual(parseRange('bytes=-3', 10), [7, 9]);
  for (const header of ['bytes=-0', 'bytes=10-', 'bytes=4-2', 'bytes=-', 'bytes=0-1,2-3']) {
    assert.equal(parseRange(header, 10), null);
  }
  assert.equal(parseRange('bytes=0-', 0), null);
});
