import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// Production components, isolated browser. No accounts or CLI calls.
// --example <json> optionally supplies local-only { assistantText, userText, title, createdAt }.
const root = process.cwd();
await fs.mkdir(path.join(root, '.test-data'), { recursive: true });
const out = await fs.mkdtemp(path.join(root, '.test-data', 'conversation-typography-'));
const modulePath = name => JSON.stringify(path.join(root, name).replaceAll('\\', '/'));
const exampleIndex = process.argv.indexOf('--example');
const example = exampleIndex >= 0 ? JSON.parse(await fs.readFile(process.argv[exampleIndex + 1], 'utf8')) : undefined;
const prose = `这轮验证已完成，**保留达标基线**。候选方案的精度已通过，速度仍需单独测量。

接下来在相同环境中比较耗时，避免把不同设备的结果直接放在一起。

## 验证结果

- **精度**：两种方案均满足当前门槛。
- **速度**：候选方案尚未完成统一测试。
  - 使用相同设备和输入规模。
  - 记录预热次数与重复测量的分布。
- **下一步**：先完成测量，再决定是否替换基线。

### 测量方法

先固定输入，再运行脚本。参数使用同一份配置，原始输出保留在本地。

> 当前结果只覆盖测试集 A。
>
> 测试集 B 尚未验证，暂不扩大适用范围。

\`\`\`python
results = benchmark(candidate, dataset="A", warmup=5)
print(results.median_ms)
\`\`\`

### 待办事项

1. 完成候选方案的耗时测量。

   补充设备、输入规模和重复次数，便于其他成员复现。

2. 对比基线后再更新项目记录。

   没有完成测量时，保留“速度待确认”的标记。

- [x] 记录精度结果
- [ ] 补充耗时数据

| 方案 | 精度 | 速度 |
| --- | --- | --- |
| 基线 | 达标 | 已测量 |
| 候选方案 | 达标 | 待测量 |

误差使用 $E = |y - \\hat y|$ 表示。
`;
const localPath = 'D:\\项目目录\\' + 'long_directory_name_'.repeat(12) + '\\results.json';
const reportUrl = 'https://example.com/reports/' + 'long_result_name_'.repeat(15);
const widthProbe = [
  '正文、路径、代码、表格和图表应该共用一个阅读列。',
  '本地路径：`' + localPath + '`',
  '报告链接：[' + reportUrl + '](' + reportUrl + ')',
  '```text\n' + 'long_unbroken_code_'.repeat(35) + '\n```',
  '| 字段 | 值 | 说明 | 来源 | 状态 | 下一步 |\n|---|---|---|---|---|---|\n| A | B | C | D | E | F |',
  '```mermaid\nflowchart LR\nA[读取输入] --> B[运行验证] --> C[记录结果] --> D[检查误差] --> E[比较方案]\n```',
].join('\n\n');
const overflowProbe = '\n\n' + widthProbe;
let browser, server;
const errors = [];
try {
  await fs.writeFile(path.join(out, 'entry.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from ${modulePath('src/renderer/markdown')};
import { ConversationMessage } from ${modulePath('src/renderer/conversation-message')};
import { SessionTranscript } from ${modulePath('src/renderer/session-transcript')};
import { PendingSessionMessage } from ${modulePath('src/renderer/pending-session-message')};
import { RequestCard } from ${modulePath('src/renderer/request-card')};
import { SubsessionChat } from ${modulePath('src/renderer/subsession-chat')};
import { SideChatPanel } from ${modulePath('src/renderer/side-chat')};
import ${modulePath('src/renderer/styles.css')};
import ${modulePath('src/renderer/subsession-chat.css')};
import ${modulePath('src/renderer/session-transcript.css')};
import ${modulePath('src/renderer/session-toolbar.css')};
import 'katex/dist/katex.min.css';
import ${modulePath('src/renderer/conversation-typography.css')};
const prose=${JSON.stringify(prose)}, example=${JSON.stringify(example || null)};
const date='2026-10-22T00:00:00Z';
const user={id:'u',role:'user',text:'比较目前的结果，并说明下一步怎么做。',createdAt:date};
const assistant={id:'a',role:'assistant',text:prose,createdAt:date};
const tool={id:'t',role:'tool',text:'Read validation.json\\n{"accuracy":"passed"}',createdAt:date};
const base={id:'fixture',title:'排版预览',provider:'codex',purpose:'work',cwd:'/fixture',status:'idle',sources:[],approvals:[]};
window.copies=[]; window.failCopy=false;
const api={call:async(action,payload)=>{if(action==='copy'){if(window.failCopy)throw Error('test');window.copies.push(payload);return;}throw Error('Unexpected IPC: '+action);}};
window.workbench=api;
const root=createRoot(document.getElementById('root'));
window.renderFixture=(mode='main',extra='')=>{
  const session={...base,messages:[user,tool,{...assistant,text:prose+extra}]};
  const child=<SubsessionChat session={session} sessions={[session]} api={api} active={false} edit={()=>{}} open={()=>{}} promote={()=>{}} remove={()=>{}} closed={()=>{}} changed={async()=>{}}/>;
  const mainSession=mode==='example' && example ? {...base,title:example.title,messages:[{...user,text:example.userText},{...assistant,text:example.assistantText,createdAt:example.createdAt}]} : mode==='widths' ? {...base,messages:[{...assistant,text:${JSON.stringify(widthProbe)}}]} : session;
  root.render(<div className="fixture-shell" data-mode={mode}>
    <main className="main-content">
      {mode==='child' ? child : mode==='side' ? <SideChatPanel chats={[{id:'side',parentId:'parent',parentTitle:'父会话',session,draft:'',expired:false}]} selectedId='side' select={()=>{}} api={api} changed={async()=>{}}/> : <>
        <header className="session-toolbar"><h2>{mainSession.title}</h2><div className="row"><button className="secondary compact">整理</button><button className="secondary compact">提问</button><button className="icon" aria-label="更多会话操作">⋯</button></div></header>
        <div className="messages"><div className="selection-content"><SessionTranscript session={mainSession} renderMessage={message=><ConversationMessage message={message} provider='codex'/>}/></div>
          {mode==='states' && <><PendingSessionMessage pending={{text:'消息已发送，等待处理。',beforeMessageCount:0,phase:'submitting'}} messages={[]}/><ConversationMessage provider='codex' message={{...user,id:'member',context:{questionRunId:'q'}}} pendingLabel='已放入对话，正在连接本地 CLI…'/><ConversationMessage provider='codex' message={{...user,id:'steer',steering:true}}/><RequestCard request={{id:'approval',title:'允许执行验证命令？',details:'运行本地测试',options:[{id:'allow',label:'允许',kind:'allow'},{id:'deny',label:'拒绝',kind:'deny'}]}} onAnswer={()=>{}}/></>}
        </div>
        <div className="composer-wrap"><div className="composer"><textarea aria-label="会话输入" placeholder="继续对话…"/><div className="composer-bottom"><button className="text-button">＋</button><button className="text-button">Codex ▾</button><button className="text-button">请求批准 ▾</button><span className="composer-shortcut">Enter 发送</span><button className="send" aria-label="发送">↑</button></div></div></div>
      </>}
    </main>
    {mode==='split' && <aside className="fixture-panel">{child}</aside>}
    <div id="document-preview"><Markdown text='预览文档保持原来的排版。'/></div>
  </div>);
};
window.overflowProbe=${JSON.stringify(overflowProbe)};
window.renderFixture();
`);
  await build({ entryPoints: [path.join(out, 'entry.tsx')], outdir: out, entryNames: 'renderer', bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'chrome130', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } });
  const html = (await fs.readFile('src/renderer/index.html', 'utf8')).replace('</head>', '<style>body{background:white}.fixture-shell{display:flex;height:100vh;min-width:0}.fixture-panel{width:360px;flex:none;display:flex;border-left:1px solid #e0e6e2}.fixture-shell .main-content{flex:1;min-width:0;display:flex;flex-direction:column}.fixture-shell[data-mode=side] .side-chat-panel{width:100%;height:100%;display:flex;flex-direction:column}#document-preview{display:none}</style></head>');
  await fs.writeFile(path.join(out, 'index.html'), html);
  server = http.createServer(async (req, res) => {
    try {
      const name = path.basename(decodeURIComponent(new URL(req.url, 'http://localhost').pathname)) || 'index.html';
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(name)];
      res.setHeader('Content-Type', mime || 'application/octet-stream'); res.end(await fs.readFile(path.join(out, name)));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('.markdown .katex').waitFor();
  const main = page.locator('main');
  const checkColumn = async label => {
    const columns = await page.locator('.assistant .markdown').evaluateAll(elements => elements.flatMap(md => {
      const reference = md.querySelector('p')?.getBoundingClientRect();
      if (!reference?.width) return [];
      return [{ reference: { x: reference.x, width: reference.width }, blocks: [...md.children].map(el => {
        const rect = el.getBoundingClientRect();
        return { kind: el.className || el.tagName, x: rect.x, width: rect.width, overflowingParagraph: el.tagName === 'P' && el.scrollWidth > el.clientWidth + 1 };
      }) }];
    }));
    assert(columns.length, label + ': rendered conversation');
    for (const column of columns) for (const block of column.blocks) {
      assert(Math.abs(block.x - column.reference.x) <= 1 && Math.abs(block.width - column.reference.width) <= 1, `${label}: content edges differ: ${JSON.stringify({reference:column.reference,block})}`);
      assert(!block.overflowingParagraph, label + ': inline path/link must wrap within prose');
    }
    return columns;
  };
  const measure = () => main.evaluate(root => {
    const get = selector => root.querySelector(selector), rect = selector => get(selector).getBoundingClientRect();
    const prose = rect('.assistant .markdown > p'), composer = get('.composer')?.getBoundingClientRect();
    const md = get('.assistant .markdown'), css = getComputedStyle(md);
    const user = rect('.user'), bubble = rect('.user .message-surface');
    return { prose: { x: prose.x, width: prose.width }, composer: composer && { x: composer.x, width: composer.width }, bubble: { right: bubble.right, width: bubble.width, columnRight: user.right, columnWidth: user.width }, article: rect('.assistant').width, font: css.fontSize, line: css.lineHeight, gap: parseFloat(getComputedStyle(get('.assistant .markdown > p')).marginBottom), sectionGap: parseFloat(getComputedStyle(get('.assistant h2')).marginTop), listGap: parseFloat(getComputedStyle(get('.assistant li + li')).marginTop), overflow: md.scrollWidth > md.clientWidth + 1, bodyOverflow: document.documentElement.scrollWidth > innerWidth + 1, codeWidths: [...md.querySelectorAll('.markdown-code-block')].map(el=>el.getBoundingClientRect().width), codeScrolls: [...md.querySelectorAll('pre')].some(el=>el.scrollWidth>el.clientWidth), tableScrolls: [...md.querySelectorAll('.markdown-table')].some(el=>el.scrollWidth>el.clientWidth) };
  });
  const wide = await measure();
  assert.equal(wide.prose.width, 700); assert.equal(wide.article, 700);
  assert.equal(wide.composer.width, 700); assert(Math.abs(wide.composer.x - wide.prose.x) <= 1);
  assert(wide.bubble.width < wide.bubble.columnWidth && Math.abs(wide.bubble.right - wide.bubble.columnRight) <= 1);
  assert.equal(wide.font, '14px'); assert(wide.sectionGap > wide.gap && wide.gap > wide.listGap);
  assert.equal(await main.locator('.assistant > .message-surface > .message-author').count(), 0);
  assert.equal(await main.locator('.conversation-message-footer time').count(), 1);
  assert.equal(await page.locator('#document-preview .markdown').evaluate(el=>getComputedStyle(el).lineHeight), '24.7px');
  await page.screenshot({ path: path.join(out, 'desktop.png'), timeout: 10000 });
  // Reply/code copy remain distinct and recover from failures.
  await main.getByRole('button', {name:'复制这条回复'}).click();
  assert.equal(await page.evaluate(()=>window.copies.at(-1)), prose);
  await main.getByRole('button', {name:'复制代码',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.copies.at(-1)), 'results = benchmark(candidate, dataset="A", warmup=5)\nprint(results.median_ms)');
  await page.evaluate(()=>{window.failCopy=true;});
  await main.getByRole('button', {name:'复制这条回复'}).click();
  await main.getByRole('alert').filter({hasText:'复制失败'}).waitFor();
  await page.evaluate(()=>{window.failCopy=false;});
  await main.getByRole('button', {name:'复制这条回复'}).click();
  assert.equal(await main.getByRole('alert').count(), 0);
  // Expansion survives streaming updates of the same turn.
  await main.locator('.turn-activity-group > summary').click();
  await main.locator('.tool-execution-group > summary').click();
  await page.evaluate(()=>window.renderFixture('main', window.overflowProbe));
  await main.locator('.markdown-code-block').nth(1).waitFor();
  assert.equal(await main.locator('.tool-execution-group').evaluate(el=>el.open), true);
  const expanded = await measure();
  assert.equal(expanded.prose.width, 700); assert.equal(Math.max(...expanded.codeWidths), 700);
  assert(expanded.codeScrolls && !expanded.overflow && !expanded.bodyOverflow);
  await checkColumn('desktop with long content');
  const layouts = [];
  for (const [mode, width] of [['main',920], ['split',1080], ['main',390], ['child',390], ['side',390]]) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(mode=>window.renderFixture(mode, window.overflowProbe), mode);
    await main.locator('.assistant .markdown-code-block').nth(1).waitFor();
    const metrics = await measure();
    assert(!metrics.overflow && !metrics.bodyOverflow, `${mode}/${width}: ${JSON.stringify(metrics)}`);
    assert(metrics.prose.width <= 700 && metrics.article <= 700);
    assert(metrics.codeScrolls);
    if (width === 390) assert(metrics.tableScrolls);
    if (metrics.composer) { assert(Math.abs(metrics.composer.width-metrics.prose.width)<=1,JSON.stringify(metrics)); assert(Math.abs(metrics.composer.x-metrics.prose.x)<=1,JSON.stringify(metrics)); }
    assert.equal(metrics.font,wide.font); assert.equal(metrics.line,wide.line);
    await checkColumn(mode + '/' + width);
    layouts.push({mode,width,...metrics});
    await page.screenshot({path:path.join(out,`${mode}-${width}.png`),timeout:10000});
  }
  await page.setViewportSize({width:1200,height:1000});
  await page.evaluate(()=>window.renderFixture('states'));
  await main.getByRole('status', {name:'消息正在提交'}).waitFor();
  assert.equal(await main.getByText('成员消息',{exact:true}).count(), 1);
  assert.equal(await main.getByText('引导',{exact:true}).count(), 1);
  assert.equal(await main.getByRole('button',{name:'允许',exact:true}).isEnabled(), true);
  await main.locator('.messages').evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.screenshot({path:path.join(out,'pending-permission.png'),timeout:10000});
  const columnChecks = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({width,height:1000});
    await page.evaluate(()=>window.renderFixture('widths'));
    await main.locator('.mermaid-diagram-image').waitFor({timeout:15000});
    columnChecks.push({width, columns:await checkColumn('mixed content/' + width)});
    assert.equal(await main.locator('.markdown > p code').innerText(),localPath);
    assert.equal(await main.locator('.markdown a').getAttribute('href'),reportUrl);
    await main.getByRole('button',{name:'放大',exact:true}).click();
    await main.getByRole('button',{name:'放大',exact:true}).click();
    await checkColumn('zoomed diagram/' + width);
    assert(await main.locator('.mermaid-diagram-viewport').evaluate(el=>el.scrollWidth>el.clientWidth));
    await main.getByRole('button',{name:'适应宽度',exact:true}).click();
    await main.locator('.messages').evaluate(el=>{el.scrollTop=0;});
    await page.screenshot({path:path.join(out,`same-width-${width}.png`),timeout:10000});
  }
  if (example) {
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(()=>window.renderFixture('example'));
    await main.locator('.assistant .markdown > p').first().waitFor();
    if (example.assistantText.includes('```mermaid')) await main.locator('.mermaid-diagram-image').waitFor({timeout:15000});
    await checkColumn('real project reply');
    await main.locator('.messages').evaluate(el=>{el.scrollTop=0;});
    await page.screenshot({path:path.join(out,'real-reply-top.png'),timeout:10000});
    await main.locator('.messages').evaluate(el=>{el.scrollTop=el.scrollHeight/2;});
    await page.screenshot({path:path.join(out,'real-reply-middle.png'),timeout:10000});
    await main.locator('.messages').evaluate(el=>{el.scrollTop=el.scrollHeight;});
    await page.screenshot({path:path.join(out,'real-reply-bottom.png'),timeout:10000});
    await main.getByRole('button',{name:'复制这条回复'}).click();
    assert.equal(await page.evaluate(()=>window.copies.at(-1)), example.assistantText);
    assert.equal(await main.locator('.markdown table').count(),(example.assistantText.match(/^\|[\s:|-]+\|$/gm)||[]).length);
  }
  assert.deepEqual(errors, []);
  const result={passed:true,wide,expanded,layouts,columnChecks,realExample:!!example,output:out};
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally {
  await browser?.close();
  if (server) await new Promise(resolve=>server.close(resolve));
}
