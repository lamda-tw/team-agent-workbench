import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const root = process.cwd(), output = path.join(root, '.test-data', 'native-import-' + Date.now());
await fs.mkdir(output, { recursive: true });
const source = file => path.join(root, file).replaceAll('\\', '/');
await fs.writeFile(path.join(output, 'entry.tsx'), `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{NativeSessionPicker}from'${source('src/renderer/native-sessions')}';
import'${source('src/renderer/styles.css')}';import'${source('src/renderer/native-sessions.css')}';
function App(){const[provider,setProvider]=useState();return <><button onClick={()=>setProvider('codex')}>打开 Codex 导入</button><button onClick={()=>setProvider('cursor')}>打开 Cursor 导入</button>{provider&&<NativeSessionPicker key={provider} provider={provider} projectId="target" close={()=>setProvider(undefined)} linked={sessions=>{window.imported=sessions;setProvider(undefined);}}/>}</>;}createRoot(document.getElementById('root')).render(<App/>);`);
await build({ entryPoints: [path.join(output, 'entry.tsx')], bundle: true, outfile: path.join(output, 'ui.js'), jsx: 'automatic', platform: 'browser', target: 'chrome120' });
await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } }), errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.calls = []; window.markLinked = false; window.failImport = false;
  window.workbench = { call: async (action, payload) => {
    window.calls.push({ action, payload });
    if (action === 'session.native.list') return { provider: payload.provider,
      groups: [{ id: 'p1', name: '算法优化项目', position: 0, kind: 'project' }, { id: 'p2', name: '软件开发项目', position: 1, kind: 'project' }],
      sessions: [
        { nativeId: 'a', name: '量化误差分析', groupId: 'p1', cwd: 'D:/algorithm', updatedAt: 3, ...(window.markLinked ? { linkedSessionId: 'wb-a' } : {}) },
        { nativeId: 'b', name: '已经加入工作台', groupId: 'p1', cwd: 'D:/algorithm', updatedAt: 2, linkedSessionId: 'wb-b' },
        { nativeId: 'c', name: '工作目录已删除', groupId: 'p1', cwd: '', updatedAt: 1, unavailable: '工作目录已经不在，无法在工作台继续' },
        { nativeId: 'd', name: '修复测试覆盖', groupId: 'p2', cwd: 'D:/software', updatedAt: 4 },
        { nativeId: 'e', name: '尚未归入项目', cwd: 'D:/other', updatedAt: 5 },
      ] };
    if (action === 'session.native.linkMany') {
      if (window.failImport) { window.markLinked = true; throw new Error('量化误差分析已在工作台，不能重复导入'); }
      return payload.nativeIds.map(id => ({ id, provider: payload.provider }));
    }
    throw new Error('Unexpected IPC: ' + action);
  } };
});
try {
  await page.goto(pathToFileURL(path.join(output, 'index.html')).href);
  for (const provider of ['Codex', 'Cursor']) {
    await page.evaluate(() => { window.markLinked = false; window.failImport = false; });
    await page.getByRole('button', { name: '打开 ' + provider + ' 导入' }).click();
    const dialog = page.getByRole('dialog'), nav = page.getByRole('navigation');
    await expect(dialog.getByRole('checkbox', { name: /已经加入工作台/ })).toBeDisabled();
    await expect(dialog.getByRole('checkbox', { name: /工作目录已删除/ })).toBeDisabled();
    await nav.getByRole('button', { name: /算法优化项目/ }).click();
    await expect(dialog.getByRole('checkbox')).toHaveCount(3);
    await expect(dialog.getByRole('checkbox', { name: /修复测试覆盖/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: '全选当前列表', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: /量化误差分析/ })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('checkbox', { name: /已经加入工作台/ })).toHaveAttribute('aria-checked', 'false');
    await nav.getByRole('button', { name: /软件开发项目/ }).click();
    await dialog.getByRole('button', { name: '全选当前列表', exact: true }).click();
    await expect(dialog.getByText('已选 2 条')).toBeVisible();
    await nav.getByRole('button', { name: /算法优化项目/ }).click();
    await dialog.getByRole('button', { name: '取消当前列表选择' }).click();
    await expect(dialog.getByText('已选 1 条')).toBeVisible();
    await dialog.getByRole('button', { name: '全选当前列表', exact: true }).click();
    await page.evaluate(() => { window.markLinked = true; });
    await dialog.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(dialog.getByText('已选 1 条')).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: /量化误差分析/ })).toBeDisabled();
    await dialog.getByRole('button', { name: '导入 1 条' }).click();
    await expect(dialog).toHaveCount(0);
    const call = await page.evaluate(() => window.calls.filter(call => call.action === 'session.native.linkMany').at(-1));
    assert.deepEqual(call.payload.nativeIds, ['d']); assert.equal(call.payload.provider, provider.toLowerCase());
  }
  await page.evaluate(() => { window.markLinked = false; window.failImport = true; });
  await page.getByRole('button', { name: '打开 Codex 导入' }).click();
  const dialog = page.getByRole('dialog');
  await page.getByRole('navigation').getByRole('button', { name: /算法优化项目/ }).click();
  await dialog.getByRole('checkbox', { name: /量化误差分析/ }).click();
  await dialog.getByRole('button', { name: '导入 1 条' }).click();
  await expect(dialog.getByRole('alert')).toContainText('不能重复导入');
  await expect(dialog.getByRole('checkbox', { name: /量化误差分析/ })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '导入所选' })).toBeDisabled();
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts', 'native-session-projects.png') });
  await page.setViewportSize({ width: 600, height: 760 });
  assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'small windows must not overflow horizontally');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('Native import UI passed: project navigation, cross-project selection, disabled linked/unavailable sessions, scoped select-all, refresh and stale-submit protection, Codex/Cursor separation, cancellation and small-window layout.');
} finally { await browser.close(); }
