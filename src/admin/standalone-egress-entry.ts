import path from 'node:path';
import fs from 'node:fs/promises';
import { runStandaloneEgress } from './standalone-egress';

void runStandaloneEgress(process.stdin, __dirname).catch(async () => {
  // Do not echo validation input or upstream credentials into task logs.
  await fs.writeFile(path.join(__dirname, 'status.json'), JSON.stringify({ running: false, error: '启动失败，请检查出口配置、端口占用或安装凭据', updatedAt: new Date().toISOString() })).catch(() => {});
  process.exit(1);
});
