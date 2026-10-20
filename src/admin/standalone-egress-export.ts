import { app, safeStorage } from 'electron';
import path from 'node:path';
import { exportStandaloneEgress } from './standalone-egress-state';

const argument = process.argv.indexOf('--admin-data');
const root = argument >= 0 ? process.argv[argument + 1] : undefined;
if (!root || !path.isAbsolute(root)) { process.stderr.write('需要管理端数据目录的绝对路径'); app.exit(1); }
else {
  app.setPath('userData', root);
  if (!app.requestSingleInstanceLock()) { process.stderr.write('请先关闭管理端，再安装独立出口'); app.exit(1); }
  else void app.whenReady().then(async () => {
    const state = await exportStandaloneEgress(root, value => {
      if (value.toString('utf8').trimStart().startsWith('{')) return value.toString('utf8');
      if (!safeStorage.isEncryptionAvailable()) throw new Error('无法解密');
      return safeStorage.decryptString(value);
    });
    // The installer captures this pipe in memory; never print it in a console/log.
    process.stdout.write(JSON.stringify(state), () => app.exit(0));
  }).catch(() => { process.stderr.write('无法读取原出口身份；请使用原 Windows 账号，确认出口配置、证书和隧道授权完整。不会创建新的接入码。'); app.exit(1); });
}
