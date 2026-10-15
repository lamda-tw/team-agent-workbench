import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readCursorDesktopHistory } from '../src/core/cursor-desktop-history';

// Reads one explicitly selected native session; never starts a model or a CLI turn.
const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const id = option('--native-id'), cwd = option('--cwd');
if (!id || !cwd) throw new Error('用法：npx tsx scripts/cursor-native-history-audit.ts --native-id <UUID> --cwd <原工作目录> [--output <JSON 文件>]');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const database = path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const snapshot = readCursorDesktopHistory(database, id, path.resolve(cwd));
const output = option('--output');
if (output) {
  const target = path.resolve(output);
  if (path.extname(target).toLowerCase() !== '.json') throw new Error('导出文件必须为 JSON');
  if (fs.existsSync(target)) throw new Error('导出文件已经存在，请选择新的文件名');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Root credentials are never returned by the reader. Do not export the native system prompt.
  const exportable = { ...snapshot, promptMessages: snapshot.promptMessages.filter(message => message.role !== 'system'), archivedMessages: snapshot.archivedMessages.filter(message => message.role !== 'system') };
  fs.writeFileSync(target, JSON.stringify(exportable, null, 2), { flag: 'wx' });
}
console.log(JSON.stringify({ nativeId: snapshot.nativeId, headers: snapshot.headersCount, bubbles: snapshot.bubbles.length,
  tools: snapshot.bubbles.filter(bubble => bubble.toolFormerData).length,
  promptMessages: snapshot.promptMessages.length, archivedMessages: snapshot.archivedMessages.length,
  toolArtifacts: snapshot.toolArtifacts.map(artifact => ({ kind: artifact.kind, bytes: Buffer.byteLength(artifact.content) })),
  missingHistoricalTools: snapshot.toolCoverage.filter(tool => tool.source === 'missing').length,
  summaryArchives: snapshot.summaryArchiveCount, settled: snapshot.settled, issues: snapshot.issues,
  ...(output ? { output: path.resolve(output) } : {}) }, null, 2));
