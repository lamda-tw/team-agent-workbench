import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeHandoffAtomic(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, text, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (error: any) { if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt)); }
    }
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
