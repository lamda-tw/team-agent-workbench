import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexCapabilities, cursorCommandCapabilities, cursorPluginCapabilities } from '../src/core/provider-capabilities';

test('Codex capability catalog keeps native skill paths and installed plugin mention paths', () => {
  const catalog = codexCapabilities({ data: [{ skills: [{ name: 'review', description: 'Review code', enabled: true, path: 'C:\\skills\\review\\SKILL.md', scope: 'repo' }] }] }, { marketplaces: [{ name: 'curated', plugins: [{ id: 'drive@curated', name: 'drive', installed: true, enabled: true, availability: 'AVAILABLE', interface: { displayName: 'Drive', shortDescription: 'Files', enabled: true } }] }] });
  assert.deepEqual(catalog.skills.map(item => [item.id, item.invocation, item.path]), [['skill:review', 'review', 'C:\\skills\\review\\SKILL.md']]);
  assert.deepEqual(catalog.plugins.map(item => [item.id, item.invocation, item.path]), [['plugin:drive@curated', 'drive', 'plugin://drive@curated']]);
});
test('same-name Codex skills retain distinct native paths and selections', () => {
  const catalog = codexCapabilities({ data: [{ skills: [{ name: 'review', path: 'C:/personal/SKILL.md', scope: 'user' }, { name: 'review', path: 'D:/project/SKILL.md', scope: 'repo' }] }] }, {});
  assert.equal(catalog.skills.length, 2); assert.notEqual(catalog.skills[0].id, catalog.skills[1].id); assert.equal(catalog.skills[0].invocation, catalog.skills[1].invocation);
});

test('Cursor catalog separates native skills, local plugins and MCP servers', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-capabilities-'));
  await fs.mkdir(path.join(cwd, '.cursor'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { database: { type: 'http', url: 'https://example.invalid/mcp' }, disabled: { command: 'node', disabled: true } } }));
  const skills = cursorCommandCapabilities([{ name: 'copy-request-id', description: 'internal' }, { name: 'review', description: 'Review code' }]);
  const home = path.join(cwd, 'home');
  const pluginDir = path.join(home, '.cursor', 'plugins', 'local', 'research'); await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'research', description: 'Research tools' }));
  const plugins = await cursorPluginCapabilities(cwd, home);
  assert.deepEqual(skills.map(item => item.id), ['skill:review']);
  assert.deepEqual(plugins.map(item => item.id), ['plugin:research']);
  assert(!plugins.some(item => item.id.startsWith('plugin:mcp:')));
  await fs.rm(cwd, { recursive: true, force: true });
});
