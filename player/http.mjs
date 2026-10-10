// "bytes=0-99" / "bytes=100-" / "bytes=-100" -> [start, end] inclusive, or null if unusable.
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start <= end && start < size ? [start, end] : null;
}

// Reads a request body, refusing anything over 1 MB.
export function readBody(req, res, done) {
  const chunks = [];
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if (size <= 1e6) chunks.push(chunk);
    else chunks.length = 0;
  });
  req.on('end', () => size > 1e6 ? res.writeHead(413).end() : done(Buffer.concat(chunks).toString('utf8')));
}
