import readline from 'node:readline';
const mode = process.env.TEST_PROVIDER || 'codex';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const nativeId = 'native-session-1';
let turn = 0;
let forks = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize' || m.method === 'authenticate' || m.method === 'session/set_mode') send({ id: m.id, result: {} });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: nativeId, path: '/fake/native-session.jsonl' } } });
  else if (m.method === 'thread/fork') {
    if (m.params.threadId !== nativeId || m.params.excludeTurns !== true || m.params.lastTurnId) send({ id: m.id, error: { code: -32602, message: 'unexpected fork boundary' } });
    else send({ id: m.id, result: { thread: { id: 'fork-' + ++forks, path: '/fake/fork-' + forks + '.jsonl' } } });
  }
  else if (m.method === 'session/new' || m.method === 'session/load') send({ id: m.id, result: { sessionId: nativeId } });
  else if (m.method === 'turn/start') {
    turn++;
    send({ id: m.id, result: { turn: { id: 'turn-' + turn } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: nativeId, itemId: 'answer-1', delta: '中文回复' } });
    if (mode === 'codex-files') {
      if (turn === 1) send({ method: 'item/started', params: { threadId: nativeId, turnId: 'turn-1', item: { id: 'patch-1', type: 'fileChange', changes: [{ path: 'solution.py', kind: { type: 'update' }, diff: '-old\n+new' }] } } });
      send({ method: 'item/started', params: { threadId: 'another-thread', turnId: 'turn-' + turn, item: { id: 'patch-1', type: 'fileChange', changes: [{ path: 'wrong.py', diff: 'unrelated' }] } } });
      send({ id: 'approval-1', method: 'item/fileChange/requestApproval', params: { threadId: nativeId, turnId: 'turn-' + turn, itemId: 'patch-1', reason: 'retry without sandbox?' } });
    } else if (mode === 'codex-question') send({ id: 'approval-1', method: 'item/tool/requestUserInput', params: { threadId: nativeId, questions: [{ id: 'direction', question: '下一步做什么？', options: [{ label: '继续验证' }, { label: '先整理' }] }] } });
    else send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { command: 'echo test', threadId: nativeId } });
  } else if (m.method === 'session/prompt') {
    globalThis.promptRequestId = m.id;
    send({ method: 'session/update', params: { sessionId: nativeId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Cursor 中文回复' } } } });
    if (mode === 'cursor-question') send({ id: 'approval-1', method: 'cursor/ask_question', params: { sessionId: nativeId, questions: [{ id: 'direction', prompt: '先做什么？', options: [{ id: 'verify', label: '验证' }, { id: 'write', label: '写说明' }] }, { id: 'checks', prompt: '检查哪些？', allowMultiple: true, options: [{ id: 'unit', label: '单元测试' }, { id: 'ui', label: '界面测试' }] }] } });
    else send({ id: 'approval-1', method: 'session/request_permission', params: { toolCall: { title: 'test command' }, options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' }] } });
  } else if (m.id === 'approval-1' && m.result) {
    if (mode.startsWith('codex')) { send({ method: 'item/completed', params: { threadId: nativeId, item: { id: 'answer-1', type: 'agentMessage', text: '中文回复' } } }); send({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: 'turn-' + turn, status: 'completed' } } }); }
    else send({ id: globalThis.promptRequestId, result: { stopReason: 'end_turn' } });
    if (mode === 'codex-double') send({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: 'turn-' + turn, status: 'completed' } } });
  } else if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); }
});
