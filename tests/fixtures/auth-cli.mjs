import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
const root = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(root, 'auth-state.json');
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const log = event => fs.appendFileSync(path.join(root, 'auth-calls.jsonl'), JSON.stringify({ event }) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const mode = read();
const command = process.argv[2];
fs.appendFileSync(path.join(root, 'cli-launches.jsonl'), JSON.stringify(process.argv.slice(2)) + '\n');
fs.appendFileSync(path.join(root, 'cli-env.jsonl'), JSON.stringify({ HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY }) + '\n');
let approvalPolicy = mode.permissionConfig?.approval || 'on-request';
let threadId = 'fake-thread';
let cursorMode = 'agent';
let cursorSessionId = 'fake-session-' + process.pid;
if (command === '--version') console.log('fixture-cli-1.0');
else if (command === 'login') {
  log('login');
  // The workbench may retain the approved URL, but must discard all other output.
  console.log('https://cursor.com/loginDeepControl?fixture=1');
  console.error('access_token=DO_NOT_FORWARD_THIS_SECRET');
  if (mode.login === 'fail') process.exitCode = 1;
  else if (mode.login === 'hang') setInterval(() => {}, 1000);
  else setTimeout(() => { fs.writeFileSync(stateFile, JSON.stringify({ ...read(), status: 'ready' })); }, 200);
} else if (command === 'status') {
  log('status');
  if (mode.status === 'hang') setInterval(() => {}, 1000);
  else if (mode.status === 'network') { send({ status: 'error', message: 'invalid token: fetch failed ECONNRESET DO_NOT_FORWARD_THIS_SECRET' }); process.exitCode = 1; }
  else if (mode.status === 'malformed') console.log('not a status response');
  else if (mode.status === 'ready') send({ status: 'authenticated', isAuthenticated: true, userInfo: { email: 'fake@example.com' } });
  else send({ status: 'unauthenticated', isAuthenticated: false, message: 'Not logged in' });
} else if (command === 'models') {
  log('models');
  if (mode.catalog === 'hang') setInterval(() => {}, 1000);
  else if (mode.catalog === 'error' || mode.status !== 'ready') { console.error('fetch failed DO_NOT_FORWARD_THIS_SECRET'); process.exitCode = 1; }
  else console.log('Available models\n\ncursor-fixture - Cursor Fixture (current, default)\nother-fixture - Other Fixture\n\nTip: use --model <id>');
} else {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line), current = read(), turnId = current.turnId || 'fake-turn';
    const respond = value => current.rpcDelays?.[m.method] ? setTimeout(() => send(value), current.rpcDelays[m.method]) : send(value);
    const requestText = JSON.stringify(m.params || {});
    const semanticMerge = /semanticMerge|conclusionProcessing/.test(requestText);
    const preparation = semanticMerge || /destinationId|artifacts/.test(requestText);
    const promptText = (m.params?.input || m.params?.prompt || []).map(item => item.text || '').join('\n');
    const strictResult = raw => {
      if (!/preparationContractVersion:[234]/.test(promptText)) return JSON.stringify(raw);
      if (/只返回一个 JSON 对象：\{"sentence"/.test(promptText)) return JSON.stringify({
        sentence: raw.sentence || '这是用于验证项目成果整理的测试项目。',
        technologies: raw.technologies || 'CLI·会话', achievements: raw.achievements || '材料整理',
        criteria: raw.criteria || '整理结果与冻结材料一致。',
        sourceReview: { status: 'complete', inputCount: Number(promptText.match(/本次输入条数：(\d+)。/)?.[1] || 0), conversationHash: promptText.match(/冻结对话哈希：([^。]*)。/)?.[1] || '' }
      });
      const evidenceIds = JSON.parse(promptText.match(/合法来源清单：(\[[^\n]*?\])。/)?.[1] || '[]');
      const categories = JSON.parse(promptText.match(/本次用户选择的整理方面：(\[[^\n]*?\])。/)?.[1] || '["exploration"]');
      const artifacts = raw.artifacts || [{ ...raw, body: raw.body || [raw.overview, ...(raw.consensus || []), ...(raw.unresolved || [])].filter(Boolean).join(' ') }];
      const reviewed = /preparationContractVersion:[34]/.test(promptText) ? {
        sourceReview: { status: 'complete', inputCount: Number(promptText.match(/本次输入条数：(\d+)。/)?.[1] || 0), conversationHash: promptText.match(/冻结对话哈希：([^。]*)。/)?.[1] || '' },
        ...(!artifacts.length ? { emptyReason: { code: 'no_reusable_content', explanation: '本次材料没有可单独保留的新内容。', existingResultIds: [] } } : {})
      } : {};
      return JSON.stringify({ ...reviewed, artifacts: artifacts.map(item => ({ ...item,
        category: /preparationContractVersion:4/.test(promptText) ? ({finding:'exploration', verification:'exploration', design:'exploration', method_exploration:'exploration', project_standard:'project_goal', requirement:'project_goal', research:'project_material', issue:'todo', baseline_change_proposal:'todo'}[item.category] || item.category || (categories.includes('exploration') ? 'exploration' : categories[0])) : item.category || (categories.includes('finding') ? 'finding' : categories[0]),
        topic: item.topic || item.title, origin: item.origin || 'project',
        body: item.body || Object.values(item.fields || {}).join(' '),
        evidenceIds: item.evidenceIds || evidenceIds.slice(0, 1) })) });
    };
    const rsiAnswer = () => {
      const data = JSON.parse(promptText.split('REFERENCE_DATA=')[1]);
      if (promptText.startsWith('RSI_PROTOCOL_V2:learn')) return JSON.stringify({ hypothesis: '先定位实体边界，再检查泛化', evidenceIds: data.evidence.filter(item => item.source === 'interface').map(item => item.id), rules: { guidance: '建议先检查最小反例与字符偏移，等待时不打扰。', cooldownMinutes: 10, maxSuggestions: 2, retrieval: 'goal-first' } });
      return JSON.stringify({ state: { progress: '开发集边界待验证', blockers: [], unknowns: ['保留集效果'], evidenceIds: data.evidence.map(item => item.id) }, suggestions: [{ title: '先核对实体边界', action: '在开发集构造最小反例，并检查字符偏移。', reason: '现有规则未覆盖多词姓名', evidenceIds: [data.evidence[0].id], conditions: ['保留集保持冻结'], uncertainty: '需要独立评测', priority: 0.8 }] });
    };
    const answer = provider => current.rsi && promptText.startsWith('RSI_PROTOCOL_V2:') ? rsiAnswer() : semanticMerge
      ? current.mergeRaw ?? strictResult(current.mergeResult || { title: '统一整理的结论', overview: '已根据多条来源形成统一结论。', consensus: ['材料共同支持继续验证。'], conflicts: [], evidence: [], scope: '当前项目阶段', unresolved: [] })
      : preparation ? current.preparationRaw ?? strictResult(current.preparationResult || { title: '模型验证结果', body: '已根据阶段摘要整理。测试已通过。', repoUrl: 'https://github.com/owner/repo', destinationId: 'default' })
        : provider === 'codex' ? '# 模型验证结果\n已根据阶段摘要整理。测试已通过。' : '# Cursor 验证结果\n已完成。';
    if (m.method) fs.appendFileSync(path.join(root, 'rpc-calls.jsonl'), JSON.stringify(m.method === 'account/login/start' ? { ...m, params: { type: m.params.type } } : m) + '\n');
    if (m.method === 'initialize' || m.method === 'authenticate' || m.method === 'session/set_model') respond({ id: m.id, result: {} });
    else if (m.method === 'session/set_mode') { cursorMode = m.params.modeId; respond({ id: m.id, result: {} }); }
    else if (m.method === 'collaborationMode/list') send(current.noPlan ? { id: m.id, error: { code: -32601, message: 'Method not found' } } : { id: m.id, result: { data: [{ name: 'Agent', mode: 'default', model: 'gpt-fixture', reasoning_effort: 'medium' }, { name: 'Plan', mode: 'plan', model: 'gpt-fixture', reasoning_effort: 'medium' }] } });
    else if (m.method === 'getAuthStatus') send({ id: m.id, result: { requiresOpenaiAuth: current.status !== 'custom', authMethod: 'chatgpt', authToken: current.status === 'ready' ? 'fixture.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: current.accountId || 'fixture-account', chatgpt_plan_type: 'pro' } })).toString('base64url') + '.PRIVATE_FIXTURE_TOKEN' : null } });
    else if (m.method === 'account/login/start') send({ id: m.id, result: { type: m.params.type } });
    else if (m.method === 'config/read') send({ id: m.id, result: { config: { sandbox_mode: current.permissionConfig?.sandbox || 'workspace-write', approval_policy: current.permissionConfig?.approval || 'on-request', approvals_reviewer: current.permissionConfig?.reviewer || 'user', api_key: 'DO_NOT_FORWARD_THIS_SECRET', mcp_servers: current.mcpConfigs || {} }, layers: [{ name: { type: 'user' }, version: 'fixture', config: { mcp_servers: current.mcpConfigs || {} } }] } });
    else if (m.method === 'mcpServerStatus/list') send({ id: m.id, result: { data: Object.entries(current.mcpConfigs || {}).map(([name, config]) => ({ name, authStatus: 'unsupported', runtimeStatus: config.enabled === false ? 'disabled' : 'connected', tools: { search: { name: 'search', description: 'fixture tool' } }, resources: [], resourceTemplates: [] })), nextCursor: null } });
    else if (m.method === 'config/mcpServer/reload') send({ id: m.id, result: {} });
    else if (m.method === 'config/value/write' && m.params.keyPath === 'mcp_servers') { fs.writeFileSync(stateFile, JSON.stringify({ ...current, mcpConfigs: m.params.value })); send({ id: m.id, result: {} }); }
    else if (m.method === 'config/value/write' && m.params.keyPath.startsWith('mcp_servers.')) {
      const [, name, property] = m.params.keyPath.split('.'), configs = structuredClone(current.mcpConfigs || {});
      if (property) configs[name] = { ...configs[name], [property]: m.params.value }; else configs[name] = m.params.value;
      fs.writeFileSync(stateFile, JSON.stringify({ ...current, mcpConfigs: configs })); send({ id: m.id, result: {} });
    }
    else if (m.method === 'configRequirements/read') send({ id: m.id, result: { requirements: current.permissionRequirements || null } });
    else if (m.method === 'command/exec') send(current.probeBlocked ? { id: m.id, error: { code: -32000, message: 'Windows sandbox: CreateProcessAsUser failed' } } : { id: m.id, result: { exitCode: 0, stdout: 'WORKBENCH_PERMISSION_OK', stderr: '' } });
    else if (m.method === 'model/list') {
      if (current.catalog === 'hang') return;
      if (current.catalog === 'error') respond({ id: m.id, error: { code: -32000, message: 'fetch failed DO_NOT_FORWARD_THIS_SECRET' } });
      else respond({ id: m.id, result: m.params.cursor ? { data: [{ id: 'id-2', model: 'gpt-fixture-2', displayName: 'GPT Fixture 2', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Faster' }] }], nextCursor: null } : { data: [{ id: 'id-1', model: 'gpt-fixture', displayName: 'GPT Fixture', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Faster' }, { reasoningEffort: 'medium', description: 'Balanced' }, { reasoningEffort: 'high', description: 'Deeper' }, { reasoningEffort: 'not valid' }, { reasoningEffort: 'high' }] }], nextCursor: 'next' } });
    } else if (m.method === 'account/rateLimits/read') {
      if (current.quota === 'hang') return;
      if (current.quota === 'error') respond({ id: m.id, error: { code: -32000, message: 'quota network failure DO_NOT_FORWARD_THIS_SECRET' } });
      else respond({ id: m.id, result: { rateLimitsByLimitId: { codex: { primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: 1800600000 } } } } });
    }
    else if (m.method === 'skills/list') respond({ id: m.id, result: { data: [{ cwd: process.cwd(), skills: [{ name: 'codex-fixture-skill', description: 'Codex fixture skill', enabled: true, path: path.join(root, 'skills', 'codex-fixture-skill', 'SKILL.md'), scope: 'user' }], errors: [] }] } });
    else if (m.method === 'plugin/installed') respond({ id: m.id, result: { marketplaces: [{ name: 'fixture-marketplace', interface: { displayName: 'Fixture Marketplace' }, plugins: [{ id: 'fixture-plugin@fixture-marketplace', name: 'fixture-plugin', installed: true, enabled: true, availability: 'AVAILABLE', interface: { displayName: 'Fixture Plugin', shortDescription: 'Codex fixture plugin', enabled: true, capabilities: ['skills', 'mcp'] } }] }], marketplaceLoadErrors: [] } });
    else if (m.method === 'account/read') {
      log('account/read');
      if (current.status === 'hang') return;
      if (current.status === 'network') {
        const reply = () => send({ id: m.id, error: { code: -32000, message: 'fetch failed ECONNRESET DO_NOT_FORWARD_THIS_SECRET' } });
        if (current.delay) setTimeout(reply, current.delay); else reply();
      }
      else if (current.status === 'expired') send({ id: m.id, error: { code: -32000, message: 'refresh_token_expired' } });
      else { const reply = () => send({ id: m.id, result: { requiresOpenaiAuth: current.status !== 'custom', account: current.status === 'ready' ? { type: 'chatgpt', email: 'fake@example.com', planType: 'pro' } : null } }); if (current.delay) setTimeout(reply, current.delay); else reply(); }
    } else if (m.method === 'thread/start' || m.method === 'thread/resume') {
      threadId = m.params.threadId || (current.nativeHistory ? randomUUID() : m.params.ephemeral ? 'fake-background-' + process.pid : 'fake-thread');
      if (current.nativeHistory && process.env.CODEX_HOME) {
        const file = path.join(process.env.CODEX_HOME, 'sessions', `rollout-${threadId}.jsonl`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: threadId } }) + '\n');
      }
      approvalPolicy = m.params.approvalPolicy || current.permissionConfig?.approval || 'on-request';
      if (current.rejectPermissionMode) send({ id: m.id, error: { code: -32000, message: 'sandbox mode not allowed by administrator policy' } });
      else send({ id: m.id, result: { thread: { id: threadId }, ...(current.permissionRuntime ? { sandbox: { type: ({ 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' })[m.params.sandbox || current.permissionConfig?.sandbox || 'workspace-write'], networkAccess: false }, approvalPolicy: m.params.approvalPolicy || current.permissionConfig?.approval || 'on-request', approvalsReviewer: m.params.approvalsReviewer || current.permissionConfig?.reviewer || 'user', ...current.permissionRuntimeOverride } : {}) } });
    }
    else if (m.method === 'session/new' || m.method === 'session/load') { cursorSessionId = m.params.sessionId || cursorSessionId; send({ id: m.id, result: { sessionId: cursorSessionId, modes: { currentModeId: cursorMode, availableModes: (current.noPlan ? ['agent'] : ['agent', 'plan', 'ask']).map(id => ({ id, name: id })) } } }); send({ method: 'session/update', params: { sessionId: cursorSessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: current.cursorCommands ?? [{ name: 'copy-request-id', description: 'internal' }, { name: 'cursor-fixture-skill', description: 'Cursor fixture skill' }] } } }); }
    else if (m.method === 'turn/start') {
      log('turn/start');
      if (current.rejectTurn) { send({ id: m.id, error: { code: -32000, message: 'Request rejected before acceptance' } }); return; }
      send({ id: m.id, result: { turn: { id: turnId } } });
      if (current.proposedPlan && m.params.collaborationMode?.mode === 'plan') {
        const id = 'plan-' + process.pid;
        send({ method: 'item/plan/delta', params: { threadId, turnId, itemId: id, delta: 'partial' } });
        send({ method: 'turn/plan/updated', params: { threadId, turnId, plan: [{ step: 'Review', status: 'completed' }, { step: 'Build', status: 'pending' }] } });
        send({ method: 'item/completed', params: { threadId, turnId, item: { id, type: 'plan', text: current.proposedPlan } } });
        send({ method: 'turn/completed', params: { threadId, turn: { id: turnId } } }); return;
      }
      if (current.userQuestion) { send({ id: 'user-question', method: 'item/tool/requestUserInput', params: { threadId, turnId, questions: [{ id: 'direction', question: '下一步做什么？', options: [{ label: '继续验证' }, { label: '先整理' }] }] } }); return; }
      if (current.refreshAuth) { send({ id: 'auth-refresh', method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized', previousAccountId: 'fixture-account' } }); return; }
      if (current.permissionDenied) { send({ method: 'item/completed', params: { threadId, item: { id: 'denied-command', type: 'commandExecution', command: 'test command', exitCode: 1, status: 'failed', aggregatedOutput: current.permissionDenied } } }); send({ method: 'turn/completed', params: { threadId, turn: { id: turnId } } }); return; }
      if (current.toolApproval || current.policyApproval && approvalPolicy !== 'never') { send({ id: 'tool-approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'test command', cwd: process.cwd(), reason: 'Needs approval outside sandbox', availableDecisions: current.denyOnly ? ['decline'] : ['accept', 'decline'] } }); return; }
      if (current.turn === 'hang') return;
      if (current.turn === 'crash') { process.exit(9); return; }
      if (current.turn === 'success') {
        const done = () => {
          send({ method: 'item/completed', params: { threadId, item: { id: 'answer', type: 'agentMessage', text: answer('codex') } } });
          send({ method: 'turn/completed', params: { turn: { id: turnId } } });
        }; if (current.turnDelay) setTimeout(done, current.turnDelay); else done();
      } else if (current.turn === 'network') send({ method: 'turn/completed', params: { turn: { id: turnId, error: { message: 'Network timeout: connection reset' } } } });
      else if (current.fileApproval) {
        send({ method: 'item/started', params: { threadId, turnId, item: { id: 'patch-item', type: 'fileChange', changes: [{ path: 'solution.py', kind: { type: 'update' }, diff: '-old_value\n+new_value' }] } } });
        send({ id: 'patch-approval', method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'patch-item', reason: 'fixture file change' } });
      } else send({ method: 'turn/completed', params: { turn: { id: turnId, error: { message: '401 Unauthorized: Please log in again' } } } });
    } else if (m.method === 'turn/steer') {
      const reply = () => {
        if (current.steer === 'finish-reject' || current.steer === 'finish-accept') send({ method: 'turn/completed', params: { threadId, turn: { id: turnId } } });
        if (current.steer === 'unsupported') send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
        else if (current.steer === 'reject' || current.steer === 'finish-reject' || m.params.expectedTurnId !== turnId) send({ id: m.id, error: { code: -32000, message: 'No matching active turn' } });
        else {
          send({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'steer-answer-' + m.id, delta: '收到补充要求。' } });
          send({ id: m.id, result: { turnId: current.steer === 'wrong-turn' ? 'other-turn' : turnId } });
        }
      };
      if (current.steer === 'hang') return;
      if (current.steerDelay) setTimeout(reply, current.steerDelay); else reply();
    } else if (m.method === 'session/prompt') {
      if (current.proposedPlan && cursorMode === 'plan') { globalThis.planPromptId = m.id; send({ id: 'plan-question', method: 'cursor/create_plan', params: { sessionId: cursorSessionId, name: 'Implementation plan', plan: current.proposedPlan, todos: [] } }); return; }
      if (current.rejectTurn) { send({ id: m.id, error: { code: -32000, message: 'Request rejected before acceptance' } }); return; }
      if (current.userQuestion) { globalThis.questionPromptId = m.id; send({ id: 'user-question', method: 'cursor/ask_question', params: { sessionId: cursorSessionId, questions: [{ id: 'direction', prompt: '先做什么？', options: [{ id: 'verify', label: '验证' }, { id: 'write', label: '写说明' }] }, { id: 'checks', prompt: '检查哪些？', allowMultiple: true, options: [{ id: 'unit', label: '单元测试' }, { id: 'ui', label: '界面测试' }] }] } }); return; }
      if (current.toolApproval || current.policyApproval && !process.argv.includes('--force')) { globalThis.toolPromptId = m.id; send({ id: 'tool-approval', method: 'session/request_permission', params: { sessionId: cursorSessionId, toolCall: { title: 'Cursor 请求执行命令', rawInput: { command: 'test command' } }, options: current.noOnce ? [{ optionId: 'always', kind: 'allow_always' }] : [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'reject', kind: 'reject_once' }] } }); return; }
      if (current.turn === 'hang') return;
      if (current.turn === 'crash') { process.exit(9); return; }
      if (current.turn === 'success') {
        const done = () => {
          send({ method: 'session/update', params: { sessionId: cursorSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer('cursor') } } } });
          send({ id: m.id, result: { stopReason: 'end_turn' } });
        }; if (current.turnDelay) setTimeout(done, current.turnDelay); else done();
      } else send({ id: m.id, error: { code: -32000, message: current.turn === 'network' ? 'Network timeout: connection reset' : 'Unauthenticated: Please log in again' } });
    }
    else if (m.id === 'plan-question' && m.result) { log({ planResult: m.result }); send({ id: globalThis.planPromptId, result: { stopReason: 'end_turn' } }); }
    else if (m.id === 'user-question' && m.result) { log({ questionResult: m.result }); if (globalThis.questionPromptId) send({ id: globalThis.questionPromptId, result: { stopReason: 'end_turn' } }); else send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }); }
    else if (m.id === 'auth-refresh') { log(m.result?.accessToken ? 'auth-refresh-ok' : 'auth-refresh-rejected'); send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, ...(m.error ? { error: { message: m.error.message } } : {}) } } }); }
    else if (m.id === 'patch-approval' && m.result) send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    else if (m.id === 'tool-approval' && m.result) { if (globalThis.toolPromptId) send({ id: globalThis.toolPromptId, result: { stopReason: 'end_turn' } }); else send({ method: 'turn/completed', params: { threadId, turn: { id: turnId } } }); }
  });
}
