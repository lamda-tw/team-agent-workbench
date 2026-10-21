import fs from 'node:fs/promises';
import path from 'node:path';

const windowsExtensions = ['.com', '.exe', '.bat', '.cmd'];
const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, '$1');
export const isFile = async (file: string) => !!file && fs.stat(file).then(value => value.isFile(), () => false);

// Match Node's case-insensitive Windows environment lookup, including duplicate keys.
function environmentValue(env: NodeJS.ProcessEnv, name: string) {
  const key = Object.keys(env).sort().find(key => key.toLowerCase() === name.toLowerCase());
  return key ? env[key] || '' : '';
}

// Read Unicode paths directly. Decoding where.exe's OEM output as UTF-8 corrupts
// Chinese directory names; its output can also include npm's Unix shell shim.
export async function findWindowsCliOnPath(name: string, env = process.env, cwd = process.cwd(), exclude: (file: string) => boolean = () => false): Promise<string | undefined> {
  const extensions = [...new Set((environmentValue(env, 'PATHEXT') || windowsExtensions.join(';'))
    .split(';').map(value => value.trim().toLowerCase()).filter(value => windowsExtensions.includes(value)))];
  const directories = [...new Set([cwd, ...environmentValue(env, 'PATH').split(';').map(unquote).filter(Boolean)]
    .map(directory => path.resolve(cwd, directory)))];
  for (const directory of directories) {
    for (const extension of extensions) {
      const file = path.join(directory, name + extension);
      if (!exclude(file) && await isFile(file)) return file;
    }
  }
}

// A pasted npm shim path may omit the .cmd extension. Keep explicit .ps1 and
// JavaScript launchers supported, but never try to execute a Unix shim on Windows.
export async function cliFile(file: string, platform = process.platform): Promise<string | undefined> {
  if (!file) return;
  const candidate = path.resolve(unquote(file));
  if (platform === 'win32' && !path.extname(candidate)) {
    for (const extension of windowsExtensions) if (await isFile(candidate + extension)) return candidate + extension;
    return;
  }
  if (await isFile(candidate)) return candidate;
}
