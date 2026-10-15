import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

type Finding = 'enabled' | 'disabled' | 'unknown';
interface SourceEvidence { relativePath: string; sha256: string }

/** Read-only diagnostic, not a permission grant or a shared-session handshake.
 * Cursor's installed code and gate mirror describe possible integration routes;
 * neither establishes a live native owner or interception of both senders. */
export function inspectCursorNativeCapabilities(applicationDirectory: string, databaseFile: string) {
  const evidence: SourceEvidence[] = [];
  const issues: string[] = [];
  let version: string | undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(applicationDirectory, 'package.json'), 'utf8'));
    if (typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) version = manifest.version;
    else issues.push('unknown-installed-version');
  } catch { issues.push('installed-manifest-unavailable'); }
  const readSource = (relativePath: string) => {
    try {
      const source = fs.readFileSync(path.join(applicationDirectory, relativePath), 'utf8');
      evidence.push({ relativePath, sha256: createHash('sha256').update(source).digest('hex') });
      return source;
    } catch { issues.push('installed-source-unavailable:' + relativePath); return undefined; }
  };
  const extensionSource = readSource('out/vs/workbench/api/node/extensionHostProcess.js');
  // Match the observed built-in-only guard, not the presence of an API name.
  // Unknown/new source shapes remain unknown and never grant access.
  const runtimeApi = extensionSource !== undefined
    && /function\s+\w+\((\w+),(\w+)\)\{return\([^}]*\2===\x22cursorAgentHost\x22[^}]*\)\s*&&\s*!\1\.isBuiltin\s*\|\|/.test(extensionSource)
    ? 'builtin-only' as const : 'unknown' as const;
  const rendererSource = readSource('out/vs/workbench/workbench.glass.main.js');
  const desktopBridgeCommandPresent = rendererSource === undefined ? undefined : rendererSource.includes('composer.desktopBridge.sendMessage');
  let desktopBridgeGateMirror: Finding = 'unknown';
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databaseFile, { readOnly: true, timeout: 1000 });
    // Never enumerate ItemTable, read auth records or fetch the invocation token.
    const row = db.prepare('SELECT value FROM ItemTable WHERE key=?').get('cursor.desktopBridge.enabled');
    const value = row?.value;
    if (value === 'true' || value === 1 || value === 1n) desktopBridgeGateMirror = 'enabled';
    else if (value === 'false' || value === 0 || value === 0n) desktopBridgeGateMirror = 'disabled';
    else issues.push('desktop-bridge-gate-unconfirmed');
  } catch { issues.push('desktop-bridge-gate-unreadable'); }
  finally { db?.close(); }
  return {
    version, desktopBridgeCommandPresent, desktopBridgeGateMirror, runtimeExtensionApi: runtimeApi,
    sharedSessionReady: false as const,
    requiredVerification: ['live-native-owner', 'both-entry-points', 'native-state-commit', 'prompt-and-compaction-queue'],
    issues, evidence,
    scope: 'Installed API restrictions and cached gate only. No model, native command, database write or authentication record access.',
  };
}
