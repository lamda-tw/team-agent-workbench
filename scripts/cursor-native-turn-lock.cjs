const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const busy = '这条会话正在执行，请等待完成后再发送。';
const unavailable = '无法确认这条会话的执行状态，暂未发送。';
const pause = new Int32Array(new SharedArrayBuffer(4));
const normalize = value => path.resolve(value.replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1')).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

// Prototype for a native beforeSubmitPrompt/stop pair. This is not an enabled
// Workbench capability: installing it and proving both native entry points are
// covered are separate steps. It never writes Cursor's own session database.
function evaluateCursorTurnHook(input, directory, options = {}) {
  const event = input?.hook_event_name;
  if (!['beforeSubmitPrompt', 'stop'].includes(event)) return { response: {}, state: 'ignored' };
  if (options.conversationId && input?.conversation_id !== options.conversationId) return { response: {}, state: 'outside-scope' };
  const deny = state => ({ response: event === 'beforeSubmitPrompt' ? { continue: false, user_message: state === 'busy' ? busy : unavailable } : {}, state });
  if (!uuid.test(input?.conversation_id || '') || !uuid.test(input?.generation_id || '') || !path.isAbsolute(directory)) return deny('unverified');
  if (options.workspace && (!Array.isArray(input.workspace_roots) || !input.workspace_roots.some(root => typeof root === 'string' && normalize(root) === normalize(options.workspace)))) return deny('wrong-workspace');
  if (event === 'stop' && !['completed', 'aborted', 'error'].includes(input.status)) return deny('nonterminal');
  const sessionId = input.conversation_id.toLowerCase(), generationId = input.generation_id.toLowerCase();
  const root = path.resolve(directory), lock = path.join(root, sessionId + '.json'), guard = path.join(root, sessionId + '.guard');
  let guardFd;
  try {
    fs.mkdirSync(root, { recursive: true });
    if (fs.lstatSync(root).isSymbolicLink()) return deny('unverified');
    // All acquirers and releasers use this short critical section. Without it,
    // two duplicate stop events could delete a newly acquired successor lease.
    for (let attempt = 0; attempt < 50; attempt++) {
      try { guardFd = fs.openSync(guard, 'wx', 0o600); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; Atomics.wait(pause, 0, 0, 10); }
    }
    if (guardFd === undefined) return deny('busy');
    if (event === 'beforeSubmitPrompt') {
      let leaseFd;
      try { leaseFd = fs.openSync(lock, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') return deny('busy'); throw error; }
      try {
        const workspaceHash = options.workspace ? createHash('sha256').update(normalize(options.workspace)).digest('hex') : undefined;
        fs.writeFileSync(leaseFd, JSON.stringify({ version: 1, conversationId: sessionId, generationId, acquiredAt: new Date().toISOString(), workspaceHash }));
      } finally { fs.closeSync(leaseFd); }
      return { response: { continue: true }, state: 'acquired', generationId };
    }
    if (!fs.existsSync(lock)) return { response: {}, state: 'already-released' };
    if (fs.lstatSync(lock).isSymbolicLink()) return deny('unverified');
    let lease;
    try { lease = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { return deny('unverified'); }
    if (lease.version !== 1 || lease.conversationId !== sessionId || lease.generationId !== generationId) return { response: {}, state: 'not-owner' };
    fs.unlinkSync(lock);
    return { response: {}, state: 'released', generationId };
  } catch { return deny('unverified'); }
  finally {
    if (guardFd !== undefined) {
      fs.closeSync(guardFd);
      fs.unlinkSync(guard);
    }
  }
}

module.exports = { evaluateCursorTurnHook };
