import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const root = process.cwd(), out = path.join(root, '.test-data', 'composer-tools-' + Date.now());
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'entry.tsx'), `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{ComposerCapabilities}from'${path.join(root,'src/renderer/composer-capabilities').replaceAll('\\','/')}';
import{AgentCustomization}from'${path.join(root,'src/renderer/agent-customization').replaceAll('\\','/')}';
import{PlanMessage}from'${path.join(root,'src/renderer/plan-message').replaceAll('\\','/')}';
import{RequestCard}from'${path.join(root,'src/renderer/request-card').replaceAll('\\','/')}';
import{ComposerMode}from'${path.join(root,'src/renderer/composer-mode').replaceAll('\\','/')}';
import'${path.join(root,'src/renderer/styles.css').replaceAll('\\','/')}';
function App(){const[text,setText]=useState(''),[selected,setSelected]=useState([]),[custom,setCustom]=useState(false);const[session,setSession]=useState({id:'session-a',provider:'codex',purpose:'work',cwd:'D:/fixture',status:'idle',binding:{project:{id:'p'}},sources:[],messages:[],approvals:[]});window.patchSession=patch=>setSession(prev=>({...prev,...patch}));const[sample,setSample]=useState(false);
return <div style={{padding:'360px 40px 20px'}}><div className="composer"><textarea aria-label="任务输入" value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229){e.preventDefault();if(!e.repeat){window.sent.push({text,selected});setText('');setSelected([]);}}}}/><div className="composer-bottom"><ComposerCapabilities session={session} selected={selected} change={setSelected} text={text} changeText={setText} attach={()=>window.attachCount++} openSettings={()=>setCustom(true)}/><ComposerMode session={session}/></div></div>{custom&&<AgentCustomization session={session} close={()=>setCustom(false)}/>}<button onClick={()=>{setSession({...session,provider:'cursor',id:'session-cursor'});setSelected([]);}}>模拟 Cursor</button><button onClick={()=>{setSession({...session,provider:'codex',id:'plan-session',proposedPlan:{messageId:'proposal',text:'# Plan',ready:true}});setSample(true);}}>展示计划</button>{sample&&<><PlanMessage session={session} message={{id:'proposal',text:'# Plan',kind:'plan'}} render={text=><p>{text}</p>}/><RequestCard request={{id:'cursor-plan',method:'cursor/create_plan',title:'Cursor Plan',details:'# Cursor plan',options:[]}} onAnswer={(option,answers)=>window.planAnswer={option,answers}}/></>}<div aria-label="已选择能力">{selected.map(item=><button key={item.id} onClick={()=>setSelected(selected.filter(v=>v.id!==item.id))}>{item.name}</button>)}</div></div>;}createRoot(document.getElementById('root')).render(<App/>);`);
await build({ entryPoints: [path.join(out, 'entry.tsx')], bundle: true, outfile: path.join(out, 'ui.js'), jsx: 'automatic', platform: 'browser', target: 'chrome120' });
await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true }), page = await browser.newPage({ viewport: { width: 1050, height: 800 } }), errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.sent = []; window.calls = []; window.attachCount = 0; window.fail = false; window.authPending = false;
  window.servers = [{ name: 'docs', title: '文档工具', enabled: true, state: 'connected', source: '个人配置', authStatus: 'unsupported', canToggle: true, tools: [{ name: 'search', description: '查找文档' }] }, { name: 'secure', title: '需要登录的服务', enabled: true, state: 'authenticationRequired', source: '当前项目', authStatus: 'notLoggedIn', canToggle: false, tools: [] }];
  window.workbench = { call: async (action, payload) => {
    window.calls.push({ action, payload });
    if(action==='session.modes')return {modes:[{id:'default',name:'Agent',description:'执行任务'},{id:'plan',name:'Plan',description:'先制定计划'},...(payload.id==='session-cursor'?[{id:'ask',name:'Ask',description:'回答问题'}]:[])],current:'default'};
    if(action==='session.mode'){window.patchSession({mode:payload.mode});return true;}
    if(action==='session.plan.execute'){window.patchSession({proposedPlan:{messageId:'proposal',text:'# Plan',ready:true,accepted:true}});return true;}
    if(action==='session.plan.revise')return true;
    if (action === 'session.capabilities') return { provider: 'codex', skills: [{ id: 'skill:review', name: '代码检查', invocation: 'review', kind: 'skill', enabled: true, description: '检查代码问题' }], plugins: [{ id: 'plugin:drive', kind: 'plugin', name: 'Drive', invocation: 'drive', enabled: true, description: '文档' }], checkedAt: '' };
    if (action === 'session.mcp') { if(window.fail)throw Error('network'); return {servers:structuredClone(window.servers).map(s=>({...s,loginPending:s.name==='secure'&&window.authPending})),checkedAt:''}; }
    if (action === 'session.mcp.toggle') { window.servers.find(s=>s.name===payload.name).enabled=payload.enabled; window.servers.find(s=>s.name===payload.name).state=payload.enabled?'connected':'disabled'; return {}; }
    if (action === 'session.mcp.login') { window.authPending=true; return true; }
    if (action === 'session.mcp.add') { window.servers.push({name:payload.server.name,title:payload.server.name,enabled:true,state:'connected',source:'个人配置',authStatus:'unsupported',canToggle:true,tools:[]});return {}; }
    throw Error(action);
  } };
});
try {
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  const input = page.getByLabel('任务输入'), plus = page.getByRole('button', { name: '添加内容或工具', exact: true });
  await expect(plus).toBeVisible(); await expect(page.getByRole('button', { name: '选择 Skill 和插件' })).toHaveCount(0);
  await input.fill('/mcp'); await input.press('Enter');
  const mcp = page.getByRole('dialog', { name: 'MCP 服务器', exact: true });
  await expect(mcp).toBeVisible(); await expect(input).toHaveValue(''); assert.equal(await page.evaluate(()=>window.sent.length),0);
  await expect(mcp).toContainText('已连接'); await expect(mcp).toContainText('需要登录');
  await mcp.getByText('查看工具',{exact:true}).click(); await expect(mcp).toContainText('search');
  await expect(mcp.getByRole('button',{name:'添加 MCP',exact:true})).toHaveCount(0);
  await mcp.getByRole('button',{name:'打开设置',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'Codex 设置',exact:true}), manager=settings.getByRole('region',{name:'MCP 服务器'});
  await expect(settings).toBeVisible();
  await manager.getByRole('button',{name:'停用',exact:true}).click();await expect(manager).toContainText('已停用');
  await manager.getByRole('button',{name:'启用',exact:true}).click();await expect(manager).toContainText('已连接');
  await manager.getByRole('button',{name:'登录',exact:true}).click();await expect(manager.getByRole('button',{name:'登录',exact:true})).toBeDisabled();await expect(manager).toContainText('等待浏览器登录');
  await manager.getByRole('button',{name:'添加 MCP',exact:true}).click();await manager.getByLabel('名称',{exact:true}).fill('new_docs');await manager.getByLabel('服务地址').fill('https://example.com/mcp');await manager.getByRole('button',{name:'保存',exact:true}).click();await expect(manager).toContainText('new_docs');
  await page.evaluate(()=>{window.fail=true;}); await manager.getByRole('button',{name:'刷新 MCP',exact:true}).click();await expect(manager.getByRole('alert')).toContainText('读取失败');await page.evaluate(()=>{window.fail=false;});await manager.getByRole('button',{name:'刷新 MCP',exact:true}).click();await expect(manager.getByRole('alert')).toHaveCount(0);
  await input.evaluate(el=>el.value); await settings.getByRole('button',{name:'关闭工具设置'}).click();await expect(settings).toHaveCount(0);
  await input.fill('$rev');await expect(page.getByRole('dialog',{name:'选择 Skill',exact:true})).toBeVisible();await input.press('Enter');await expect(input).toHaveValue('');await expect(page.getByLabel('已选择能力')).toContainText('代码检查');assert.equal(await page.evaluate(()=>window.sent.length),0);
  await input.fill('检查代码');await input.press('Enter');assert.equal(await page.evaluate(()=>window.sent[0].text),'检查代码');assert.equal(await page.evaluate(()=>window.sent[0].selected[0].id),'skill:review');
  await input.fill('/skills');await input.press('Enter');const skills=page.getByRole('dialog',{name:'选择 Skill',exact:true});await expect(skills).toBeVisible();await skills.getByRole('option').first().click();await expect(skills).toHaveCount(0);await page.getByLabel('已选择能力').getByRole('button').click();await expect(page.getByLabel('已选择能力')).toBeEmpty();
  await input.fill('@dri');await expect(page.getByRole('dialog',{name:'选择插件',exact:true})).toBeVisible();await input.press('Tab');await expect(page.getByLabel('已选择能力')).toContainText('Drive');
  await input.fill('$rev');await input.press('Escape');await expect(skills).toHaveCount(0);await expect(input).toHaveValue('$rev');
  await input.fill('普通文本');await plus.click();const menu=page.getByRole('dialog',{name:'添加内容或工具',exact:true});await menu.getByRole('button',{name:'添加本地参考文件',exact:true}).click();assert.equal(await page.evaluate(()=>window.attachCount),1);await expect(input).toHaveValue('普通文本');
  await plus.click();await menu.getByRole('option').filter({hasText:'/mcp'}).click();await expect(mcp).toBeVisible();await page.keyboard.press('Escape');await expect(mcp).toHaveCount(0);await expect(input).toHaveValue('普通文本');
  await input.fill('/mcp');await input.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true})));await expect(mcp).toHaveCount(0);await expect(input).toHaveValue('/mcp');
  await input.fill('/usr/bin');await input.press('Enter');assert.equal(await page.evaluate(()=>window.sent.at(-1).text),'/usr/bin');
  await input.fill('解释 $HOME');await expect(page.getByRole('dialog',{name:'选择 Skill',exact:true})).toContainText('没有匹配');await input.press('Enter');assert.equal(await page.evaluate(()=>window.sent.at(-1).text),'解释 $HOME');
  await input.fill('/');await expect(menu).toBeVisible();await input.press('ArrowDown');await input.press('Enter');await expect(mcp).toBeVisible();
  const artifacts=path.join(root,'artifacts');await fs.mkdir(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'composer-mcp.png')});
  await page.keyboard.press('Escape');
  await input.fill('保留草稿'); await input.press('Shift+Tab'); await expect(page.getByLabel('选择对话模式')).toContainText('Plan'); await expect(input).toHaveValue('保留草稿');
  await input.fill('/plan'); await input.press('Enter'); await expect(page.getByLabel('选择对话模式')).toContainText('Agent'); assert(!await page.evaluate(()=>window.sent.some(item=>item.text==='/plan')));
  await page.getByRole('button',{name:'模拟 Cursor',exact:true}).click();
  await input.fill('/rev'); await expect(page.getByRole('option').filter({hasText:'代码检查'})).toBeVisible(); await input.press('Tab'); await expect(page.getByLabel('已选择能力')).toContainText('代码检查');
  await input.fill('@rev'); await expect(page.getByRole('dialog',{name:'选择 Skill',exact:true})).toBeVisible(); await input.press('Escape');
  await input.fill('/ask'); await input.press('Enter'); await expect(page.getByLabel('选择对话模式')).toContainText('Ask');
  await input.fill('Cursor 草稿'); await plus.click(); await menu.getByRole('option').filter({hasText:'/mcp'}).click(); await mcp.getByRole('button',{name:'打开设置',exact:true}).click();
  const cursorSettings=page.getByRole('dialog',{name:'Cursor 自定义',exact:true}); await expect(cursorSettings).toBeVisible(); await cursorSettings.getByRole('button',{name:'关闭工具设置'}).click(); await expect(input).toHaveValue('Cursor 草稿');
  await page.getByRole('button',{name:'展示计划',exact:true}).click(); const plan=page.getByLabel('实施计划',{exact:true});
  await plan.getByRole('button',{name:'修改计划'}).click(); await plan.getByLabel('修改实施计划').fill('Revised plan'); await plan.getByRole('button',{name:'取消修改'}).click(); await expect(input).toHaveValue('Cursor 草稿');
  await plan.getByRole('button',{name:'修改计划'}).click(); await plan.getByLabel('修改实施计划').fill('Revised plan'); await plan.getByRole('button',{name:'提交修改'}).click();
  assert(await page.evaluate(()=>window.calls.some(c=>c.action==='session.plan.revise'&&c.payload.text==='Revised plan'))); await expect(input).toHaveValue('Cursor 草稿');
  await plan.getByRole('button',{name:'执行计划'}).click(); await expect(plan.getByRole('button',{name:'已开始执行'})).toBeDisabled();
  const request=page.getByLabel('Cursor 实施计划',{exact:true}); await request.getByRole('button',{name:'修改计划'}).click(); await request.getByLabel('修改 Cursor 计划').fill('Review first'); await request.getByRole('button',{name:'提交修改'}).click();
  assert.equal(await page.evaluate(()=>window.planAnswer.option),'decline'); assert((await page.evaluate(()=>window.planAnswer.answers.reason)).includes('Review first'));
  await page.screenshot({path:path.join(root,'artifacts','composer-desktop-plans.png')});
  assert.deepEqual(errors,[]);console.log('Composer tools UI passed: compact plus menu, slash commands, keyboard/IME, $ Skill and @ plugin selection, MCP tools/status/login/add/toggle/retry, preserved drafts and close.');
} finally { await browser.close(); }
