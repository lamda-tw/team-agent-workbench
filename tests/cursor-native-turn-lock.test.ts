import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const moduleFile = path.resolve('scripts/cursor-native-turn-lock.cjs');
const { evaluateCursorTurnHook: hook } = createRequire(import.meta.url)(moduleFile);
const session = randomUUID(), first = randomUUID(), second = randomUUID();
const begin = (id = first, conversation = session) => ({ hook_event_name: 'beforeSubmitPrompt', conversation_id: conversation, generation_id: id, workspace_roots: [process.cwd()] });
const end = (id = first, status = 'completed') => ({ ...begin(id), hook_event_name: 'stop', status });
function fixture(t: any) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-native-lock-test-'));
  t.after(() => {
    const target = path.resolve(directory), base = path.resolve(os.tmpdir());
    assert(target.startsWith(base + path.sep) && path.basename(target).startsWith('cursor-native-lock-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return directory;
}
function child(event: unknown, directory: string) {
  const code = "const {evaluateCursorTurnHook}=require(process.argv[1]);console.log(JSON.stringify(evaluateCursorTurnHook(JSON.parse(process.argv[2]),process.argv[3])))";
  return new Promise<any>((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', code, moduleFile, JSON.stringify(event), directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', c => stdout += c); p.stderr.on('data', c => stderr += c);
    p.once('error', reject); p.once('exit', status => status === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

test('simultaneous independent processes admit exactly one turn for a native session', async t => {
  const directory = fixture(t), ids = Array.from({ length: 12 }, () => randomUUID());
  const results = await Promise.all(ids.map(id => child(begin(id), directory)));
  assert.equal(results.filter(r => r.response.continue === true).length, 1);
  assert.equal(results.filter(r => r.response.continue === false).length, 11);
  const lease = JSON.parse(fs.readFileSync(path.join(directory, session + '.json'), 'utf8'));
  assert.equal(lease.generationId, ids[results.findIndex(r => r.state === 'acquired')]);
});

test('different native sessions can run independently', t => {
  const directory = fixture(t);
  assert.equal(hook(begin(), directory).state, 'acquired');
  assert.equal(hook(begin(second, randomUUID()), directory).state, 'acquired');
});

test('a rejected sender and old terminal events cannot release the current owner', t => {
  const directory = fixture(t);
  hook(begin(), directory);
  assert.equal(hook(begin(second), directory).response.continue, false);
  assert.equal(hook(end(second, 'error'), directory).state, 'not-owner');
  assert.equal(hook(begin(second), directory).response.continue, false);
  assert.equal(hook(end(), directory).state, 'released');
  assert.equal(hook(begin(second), directory).state, 'acquired');
  assert.equal(hook(end(), directory).state, 'not-owner');
  assert.equal(hook(begin(randomUUID()), directory).response.continue, false);
});

test('all confirmed terminal statuses release their own turn, while waiting does not', t => {
  const directory = fixture(t);
  for (const status of ['completed', 'aborted', 'error']) {
    hook(begin(), directory);
    assert.equal(hook(end(first, 'waiting_for_input'), directory).state, 'nonterminal');
    assert.equal(hook(begin(second), directory).response.continue, false);
    assert.equal(hook(end(first, status), directory).state, 'released');
  }
});

test('duplicate stop events racing a successor never delete the successor lease', async t => {
  const directory = fixture(t); hook(begin(), directory);
  const results = await Promise.all([child(end(), directory), child(end(), directory), child(begin(second), directory)]);
  if (results[2].state !== 'acquired') assert.equal(hook(begin(second), directory).state, 'acquired');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, session + '.json'), 'utf8')).generationId, second);
});

test('the same generation is not admitted twice and old age does not force unlock', t => {
  const directory = fixture(t); hook(begin(), directory);
  const file = path.join(directory, session + '.json'), lease = JSON.parse(fs.readFileSync(file, 'utf8'));
  lease.acquiredAt = '2000-01-01T00:00:00Z'; fs.writeFileSync(file, JSON.stringify(lease));
  assert.equal(hook(begin(), directory).response.continue, false);
  assert.equal(hook(begin(second), directory).response.continue, false);
});

test('malformed state, invalid identity and unavailable storage fail closed', t => {
  const directory = fixture(t), file = path.join(directory, session + '.json');
  fs.writeFileSync(file, 'incomplete');
  assert.equal(hook(begin(), directory).response.continue, false);
  assert.equal(hook(end(), directory).state, 'unverified');
  assert.equal(fs.readFileSync(file, 'utf8'), 'incomplete');
  assert.equal(hook({ ...begin(), conversation_id: '../another-user' }, directory).response.continue, false);
  const notDirectory = path.join(directory, 'file'); fs.writeFileSync(notDirectory, 'x');
  assert.equal(hook(begin(), notDirectory).response.continue, false);
});

test('workspace and binding scope are checked without affecting other native chats', t => {
  const directory = fixture(t);
  assert.equal(hook(begin(), directory, { workspace: path.join(process.cwd(), 'different') }).state, 'wrong-workspace');
  assert.equal(hook(begin(), directory, { conversationId: randomUUID() }).state, 'outside-scope');
  assert.equal(fs.readdirSync(directory).length, 0);
  assert.equal(hook(begin(), directory, { workspace: process.cwd(), conversationId: session }).state, 'acquired');
});

test('native Windows URI-path workspace roots identify the same local directory', t => {
  const directory = fixture(t), root = process.cwd().replace(/\\/g, '/');
  const nativeRoot = /^[a-z]:\//i.test(root) ? '/' + root : root;
  assert.equal(hook({ ...begin(), workspace_roots: [nativeRoot] }, directory, { workspace: process.cwd() }).state, 'acquired');
});

test('lock records never include prompts, attachments, account identity or credentials', t => {
  const directory = fixture(t);
  hook({ ...begin(), prompt: 'private conversation', attachments: ['private file'], user_email: 'private identity', api_key: 'private key' }, directory);
  const record = fs.readFileSync(path.join(directory, session + '.json'), 'utf8');
  assert(!record.includes('private'));
});
