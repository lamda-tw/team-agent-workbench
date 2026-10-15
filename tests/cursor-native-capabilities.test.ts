import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectCursorNativeCapabilities } from '../src/core/cursor-native-capabilities';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-capabilities-'));
  const host = path.join(root, 'out/vs/workbench/api/node/extensionHostProcess.js');
  const renderer = path.join(root, 'out/vs/workbench/workbench.glass.main.js');
  fs.mkdirSync(path.dirname(host), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '3.24.18' }));
  fs.writeFileSync(host, 'function tt(e,n){return(n==="control"||n==="cursor"||n==="cursorAgentHost"||n==="cursorNoDeps")&&!e.isBuiltin||!e.enabledApiProposals?!1:e.enabledApiProposals.includes(n)}');
  fs.writeFileSync(renderer, 'composer.desktopBridge.sendMessage');
  const database = path.join(root, 'state.vscdb'), db = new DatabaseSync(database);
  db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO ItemTable VALUES(?,?)').run('cursor.desktopBridge.enabled', 'false');
  db.prepare('INSERT INTO ItemTable VALUES(?,?)').run('cursor.desktopBridge.rendererInvocationToken', 'PRIVATE_INVOCATION_TOKEN');
  db.prepare('INSERT INTO ItemTable VALUES(?,?)').run('auth-secret', 'PRIVATE_AUTH_VALUE');
  db.close();
  return { root, host, renderer, database, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the installed builtin-only restriction and disabled gate explain why the native interface cannot be assumed available', () => {
  const f = fixture();
  try {
    const result = inspectCursorNativeCapabilities(f.root, f.database);
    assert.equal(result.version, '3.24.18'); assert.equal(result.runtimeExtensionApi, 'builtin-only');
    assert.equal(result.desktopBridgeGateMirror, 'disabled'); assert.equal(result.sharedSessionReady, false);
    assert.equal(result.evidence.length, 2); assert(result.evidence.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  } finally { f.close(); }
});

test('an enabled cached gate or installed command never substitutes for a live owner and dual-entry acceptance', () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.database); db.prepare('UPDATE ItemTable SET value=? WHERE key=?').run('true', 'cursor.desktopBridge.enabled'); db.close();
    const result = inspectCursorNativeCapabilities(f.root, f.database);
    assert.equal(result.desktopBridgeGateMirror, 'enabled'); assert.equal(result.desktopBridgeCommandPresent, true);
    assert.equal(result.sharedSessionReady, false); assert(result.requiredVerification.includes('native-state-commit'));
  } finally { f.close(); }
});

test('unrecognized source shapes and missing data remain unconfirmed without creating a database or enabling integration', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.host, 'cursorAgentHost');
    const missing = path.join(f.root, 'missing.vscdb');
    const result = inspectCursorNativeCapabilities(f.root, missing);
    assert.equal(result.runtimeExtensionApi, 'unknown'); assert.equal(result.desktopBridgeGateMirror, 'unknown');
    assert.equal(result.sharedSessionReady, false); assert.equal(fs.existsSync(missing), false);
    fs.unlinkSync(f.renderer);
    assert.equal(inspectCursorNativeCapabilities(f.root, f.database).desktopBridgeCommandPresent, undefined);
  } finally { f.close(); }
});

test('the read-only report excludes authentication and bridge tokens and leaves stored data unchanged', () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.database), result = inspectCursorNativeCapabilities(f.root, f.database);
    const serialized = JSON.stringify(result);
    assert(!serialized.includes('PRIVATE_INVOCATION_TOKEN')); assert(!serialized.includes('PRIVATE_AUTH_VALUE'));
    assert.deepEqual(fs.readFileSync(f.database), before);
  } finally { f.close(); }
});
