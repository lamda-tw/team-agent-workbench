import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const provider = process.env.TEST_BACKGROUND_PROVIDER || 'codex';
let promptId;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (['initialize', 'authenticate'].includes(m.method)) send({ id: m.id, result: {} });
  else if (m.method === 'config/read') send({ id: m.id, result: { config: { mcp_servers: { external: { enabled: true } } } } });
  else if (m.method === 'thread/start') {
    const valid = m.params.sandbox === 'read-only' && m.params.approvalPolicy === 'never' && m.params.ephemeral === true && m.params.config['mcp_servers.external.enabled'] === false && m.params.config['features.shell_tool'] === false;
    send(valid ? { id: m.id, result: { thread: { id: 'background-thread' }, approvalPolicy: 'never', sandbox: { type: 'readOnly' } } } : { id: m.id, error: { code: -1, message: '后台权限未收紧' } });
  } else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'background-thread', modes: { availableModes: [{ id: 'ask' }] } } });
  else if (m.method === 'session/set_mode') send(m.params.modeId === 'ask' ? { id: m.id, result: {} } : { id: m.id, error: { code: -1, message: '必须使用 Ask' } });
  else if (m.method === 'turn/start' || m.method === 'session/prompt') {
    promptId = m.id;
    if (provider === 'codex') send({ id: m.id, result: { turn: { id: 'background-turn' } } });
    send({ id: 'forbidden', method: provider === 'codex' ? 'item/commandExecution/requestApproval' : 'session/request_permission', params: { command: 'write unwanted file', toolCall: { title: 'do not execute' } } });
  } else if (m.id === 'forbidden') {
    const refused = provider === 'codex' ? !!m.error : m.result?.outcome?.outcome === 'cancelled';
    const reply = JSON.stringify({ refused });
    if (provider === 'codex') {
      send({ method: 'item/completed', params: { threadId: 'background-thread', item: { id: 'answer', type: 'agentMessage', text: reply } } });
      send({ method: 'turn/completed', params: { threadId: 'background-thread', turn: { id: 'background-turn', status: 'completed' } } });
    } else {
      send({ method: 'session/update', params: { sessionId: 'background-thread', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } } });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
    }
  }
});
