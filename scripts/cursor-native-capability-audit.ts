import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectCursorNativeCapabilities } from '../src/core/cursor-native-capabilities';

const args = process.argv.slice(2);
const option = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const application = option('--application') || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Programs/cursor/resources/app');
const database = option('--database') || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'Cursor/User/globalStorage/state.vscdb');
const result = { inspectedAt: new Date().toISOString(), ...inspectCursorNativeCapabilities(path.resolve(application), path.resolve(database)) };
const output = option('--output');
if (output) {
  const file = path.resolve(output);
  if (path.extname(file).toLowerCase() !== '.json') throw new Error('诊断输出必须是 JSON 文件');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2), { flag: 'wx' });
}
console.log(JSON.stringify(result, null, 2));
