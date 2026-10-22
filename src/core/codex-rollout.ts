import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createZstdDecompress } from 'node:zlib';

/** Codex may compress an idle rollout and materialize it again when resumed. */
export async function resolveCodexRolloutPath(file: string) {
  const plain = file.endsWith('.jsonl.zst') ? file.slice(0, -4) : file;
  for (const candidate of [plain, ...(plain.endsWith('.jsonl') ? [plain + '.zst'] : [])]) {
    if ((await fs.stat(candidate).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }))?.isFile()) return candidate;
  }
}

export function openCodexRollout(file: string) {
  const source = createReadStream(file);
  if (!file.endsWith('.jsonl.zst')) return source;
  const decoded = createZstdDecompress();
  source.on('error', error => decoded.destroy(error));
  decoded.once('close', () => source.destroy());
  return source.pipe(decoded);
}

export async function readCodexRollout(file: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of openCodexRollout(file)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
