import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const LOG = join(dirname(fileURLToPath(import.meta.url)), 'netcut.log');

// ISO time <TAB> epoch ms <TAB> preset <TAB> exit code <TAB> stderr
export function log(r, note = '') {
  const t = new Date();
  const line = [t.toISOString(), t.getTime(), r.id + note, r.code, (r.err || '').replace(/\s+/g, ' ')].join('\t');
  appendFileSync(LOG, line + '\n');
  return line;
}

export function tailLog(n) {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').trimEnd().split('\n').slice(-n).reverse();
}
