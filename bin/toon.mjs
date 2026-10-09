// Minimal TOON encoder for motion-os-axi output: `key: value`, `key[N]: a,b`, `key[N]{f,g}:` + indented rows.
const QUOTE = /[,:"\n\r]|^\s|\s$/;

export function val(v){
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return s === '' || QUOTE.test(s) ? JSON.stringify(s) : s;
}

export function toon(obj){
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) { out.push(`${k}: ${val(v)}`); continue; }
    if (!v.length) { out.push(`${k}[0]:`); continue; }
    if (v.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      const fields = [...new Set(v.flatMap(Object.keys))];
      out.push(`${k}[${v.length}]{${fields.join(',')}}:`);
      for (const row of v) out.push('  ' + fields.map(f => val(row[f])).join(','));
    } else out.push(`${k}[${v.length}]: ${v.map(val).join(',')}`);
  }
  return out.join('\n');
}

export const trunc = (s, full, n = 120) => { s = String(s ?? ''); return full || s.length <= n ? s : s.slice(0, n) + `…(+${s.length - n} chars)`; };
