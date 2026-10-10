// Project paths shared by validation, playback and frame extraction.
import fs from 'node:fs';
import path from 'node:path';

export function insideProject(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\0') &&
    !path.isAbsolute(name) && !path.win32.isAbsolute(name) &&
    !path.normalize(name).split(/[\\/]/).includes('..');
}

export function resolveProjectFile(dir, name) {
  if (!insideProject(name)) return null;
  const file = path.resolve(dir, name);
  const fallback = path.resolve(dir, 'public', name);
  return fs.existsSync(file) || !fs.existsSync(fallback) ? file : fallback;
}
