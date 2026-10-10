import fs from 'node:fs';
import path from 'node:path';
import {
  readQueue,
  pushBatch,
  leaseQueue,
  ackQueue,
  appendTranscript,
  readTranscript,
  markTranscript,
  isWorking,
} from '../bin/store.mjs';
import { resolveProjectFile } from '../bin/project-files.mjs';
import { parseRange, readBody } from './http.mjs';
import { createExportController } from './export.mjs';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};
export function createPlayerHandler(dir, { page, playerRoot = path.dirname(page), getPort }) {
  const exports = createExportController(dir);
  // Feedback from the player's Send, queued per project until `motion-os-axi poll` takes it. One waiting poll gets each
  // batch on a 30 s lease; the batch is deleted only when that poll acks it, so a poll that dies mid-reply loses nothing.
  const waiters = [];
  function deliver() {
    while (waiters.length) {
      const res = waiters[0];
      if (res.writableEnded || res.destroyed) {
        waiters.shift();
        continue;
      }
      const batches = leaseQueue(dir);
      if (!batches.length) {
        return;
      }
      markTranscript(dir, (e) => batches.some((b) => b.id === e.id), 'picked');
      waiters.shift();
      res
        .writeHead(200, {
          'Content-Type': 'application/json',
        })
        .end(
          JSON.stringify({
            batches,
          }),
        );
    }
  }
  const retry = setInterval(deliver, 5000);
  retry.unref(); // re-offers batches whose lease ran out
  // Only our own page (same port) may POST; other pages on localhost are other sites.
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) {
      return true;
    }
    const m = /^http:\/\/(localhost|127\.0\.0\.1):(\d+)$/.exec(o);
    return !!m && Number(m[2]) === getPort();
  };
  // The feedback endpoints change state, so a page on another site (or a DNS-rebinding hostname) must not reach them.
  const hostOk = (req) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || ''); // blocks DNS-rebinding hostnames
  const localOnly = (req) =>
    hostOk(req) && req.headers['sec-fetch-site'] !== 'cross-site' && sameOrigin(req);
  const presence = () =>
    waiters.some((r) => !r.writableEnded && !r.destroyed)
      ? 'listening'
      : isWorking(readTranscript(dir))
        ? 'working'
        : 'idle';
  function handleAcknowledgement(req, res) {
    return readBody(req, res, (body) => {
      try {
        ackQueue(dir, JSON.parse(body || '{}').ids || []);
        res
          .writeHead(200, {
            'Content-Type': 'application/json',
          })
          .end('{"ok":true}');
      } catch {
        res.writeHead(400).end();
      }
    });
  }
  function handleReply(req, res) {
    return readBody(req, res, (body) => {
      let text = '';
      let ids = null;
      try {
        const j = JSON.parse(body || '{}');
        text = String(j.text || '').trim();
        ids = Array.isArray(j.ids) ? j.ids : null;
      } catch {}
      if (!text) {
        return res.writeHead(400).end();
      }
      // with ids (from motion-os-axi poll --reply), close exactly those; without, every picked batch
      appendTranscript(dir, {
        role: 'agent',
        text,
      });
      markTranscript(dir, (e) => (ids ? ids.includes(e.id) : e.status === 'picked'), 'done');
      res
        .writeHead(200, {
          'Content-Type': 'application/json',
        })
        .end('{"ok":true}');
    });
  }
  function handleTranscript(req, res) {
    return res
      .writeHead(200, {
        'Content-Type': 'application/json',
      })
      .end(
        JSON.stringify({
          entries: readTranscript(dir),
          presence: presence(),
          waiting: readQueue(dir).length,
        }),
      );
  }
  function handleFeedback(req, res) {
    const send = (code, j) =>
      res
        .writeHead(code, {
          'Content-Type': 'application/json',
        })
        .end(JSON.stringify(j));
    if (req.method !== 'POST') {
      return send(200, {
        waiting: readQueue(dir).length,
      });
    }
    return readBody(req, res, (body) => {
      try {
        const payload = JSON.parse(body || '{}');
        const b = pushBatch(dir, payload);
        appendTranscript(dir, {
          id: b.id,
          role: 'user',
          batch: payload,
          status: 'sent',
        });
        send(200, {
          ok: true,
          id: b.id,
          waiting: readQueue(dir).length,
        });
        deliver();
      } catch (e) {
        send(400, {
          ok: false,
          error: e.message,
        });
      }
    });
  }
  function handlePoll(req, res) {
    waiters.push(res);
    const ms = Math.min(
      Number(new URL(req.url, 'http://localhost').searchParams.get('ms')) || 25000,
      25000,
    );
    const t = setTimeout(() => {
      const i = waiters.indexOf(res);
      if (i >= 0) {
        waiters.splice(i, 1);
        res
          .writeHead(200, {
            'Content-Type': 'application/json',
          })
          .end('{"batches":[]}');
      }
    }, ms);
    res.on('close', () => {
      clearTimeout(t);
      const i = waiters.indexOf(res);
      if (i >= 0) {
        waiters.splice(i, 1);
      }
    });
    return deliver();
  }
  function handleExport(req, res) {
    // Only our own page may start a render (blocks other websites posting to localhost).
    const send = (j) =>
      res
        .writeHead(200, {
          'Content-Type': 'application/json',
        })
        .end(JSON.stringify(j));
    if (req.method !== 'POST') {
      return send(exports.status());
    }
    return readBody(req, res, (body) => {
      try {
        send(exports.start(JSON.parse(body || '{}')));
      } catch (e) {
        send({
          state: 'error',
          line: e.message,
        });
      }
    });
  }
  const handler = (req, res) => {
    let url;
    try {
      url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return res.writeHead(400).end();
    } // e.g. "/%"
    if (url.includes('\0')) {
      return res.writeHead(400).end();
    } // "/%00": fs would throw synchronously and take the server down
    // Every path needs a localhost Host (so a rebinding page can't read the page, files or .motion-os-axi/). The endpoints also refuse
    // cross-site browser requests; the page itself may be opened from a link on another site.
    if (!hostOk(req)) {
      return res.writeHead(403).end();
    }
    if (
      ['/feedback', '/poll', '/ack', '/export', '/reply', '/transcript'].includes(url) &&
      !localOnly(req)
    ) {
      return res.writeHead(403).end();
    }
    if (url === '/ack') {
      return handleAcknowledgement(req, res);
    }
    if (url === '/reply') {
      return handleReply(req, res);
    }
    if (url === '/transcript') {
      return handleTranscript(req, res);
    }
    if (url === '/feedback') {
      return handleFeedback(req, res);
    }
    if (url === '/poll') {
      return handlePoll(req, res);
    }
    if (url === '/export') {
      return handleExport(req, res);
    }
    const playerAsset = url.startsWith('/_player/');
    const file =
      url === '/'
        ? page
        : playerAsset
          ? resolveProjectFile(playerRoot, url.slice('/_player/'.length))
          : resolveProjectFile(dir, url.slice(1));
    if (!file) {
      return res.writeHead(403).end('Forbidden');
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        return res.writeHead(404).end('Not found');
      }
      const head = {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };
      if (req.headers.range) {
        // video seeking needs byte ranges
        const r = parseRange(req.headers.range, stat.size);
        if (!r) {
          return res
            .writeHead(416, {
              'Content-Range': `bytes */${stat.size}`,
            })
            .end();
        }
        res.writeHead(206, {
          ...head,
          'Content-Range': `bytes ${r[0]}-${r[1]}/${stat.size}`,
          'Content-Length': r[1] - r[0] + 1,
        });
        return req.method === 'HEAD'
          ? res.end()
          : fs
              .createReadStream(file, {
                start: r[0],
                end: r[1],
              })
              .pipe(res);
      }
      res.writeHead(200, {
        ...head,
        'Content-Length': stat.size,
      });
      req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
    });
  };
  return {
    handler,
    close() {
      clearInterval(retry);
      for (const res of waiters.splice(0)) {
        res.end();
      }
    },
  };
}
