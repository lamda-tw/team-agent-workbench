import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'workbench-mcp-fixture', version: '1.0' } } });
  else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [{ name: 'ping', description: 'Local protocol fixture', inputSchema: { type: 'object', properties: {} } }] } });
  else send({ id: message.id, error: { code: -32601, message: 'Fixture does not execute tools' } });
}
