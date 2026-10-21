import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/renderer/markdown';
import { isMermaidSource, prepareDiagramMarkdown } from '../src/renderer/mermaid-source';

test('explicit Mermaid fences, unlabelled diagram blocks and standalone flowchart replies enter the diagram renderer', async () => {
  const source = await fs.readFile(new URL('./fixtures/extraction-flowchart.mmd', import.meta.url), 'utf8');
  for (const text of [source, '```mermaid\n' + source + '\n```', '```\n' + source + '\n```', '图表说明。\n\n```mermaid\n' + source + '\n```\n\n图表结束。']) {
    const html = renderToStaticMarkup(React.createElement(Markdown, { text }));
    assert.match(html, /class="mermaid-diagram"/);
    assert.match(html, /正在绘制图表/);
    assert.match(html, /查看源码/);
    assert.match(html, /跨块去重合并/);
    assert.equal((html.match(/class="mermaid-diagram"/g) || []).length, 1);
  }
});

test('ordinary code, explicit text examples and prose retain their original Markdown rendering', () => {
  for (const text of ['```text\nflowchart TD\n A-->B\n```', '```python\nprint("flowchart TD")\n```', '使用 flowchart TD 来定义流程图。', '`flowchart TD` 是一个示例。']) {
    const html = renderToStaticMarkup(React.createElement(Markdown, { text }));
    assert(!html.includes('class="mermaid-diagram"'));
  }
  const fenced = '```mermaid\nflowchart TD\n A-->B\n```';
  assert.equal(prepareDiagramMarkdown(fenced), fenced);
  assert.equal(prepareDiagramMarkdown('flowchart TD\n A-->B'), '```mermaid\nflowchart TD\n A-->B\n```');
});

test('diagram recognition accepts supported headers and honors explicit code languages', () => {
  for (const source of ['flowchart LR\nA-->B', 'graph TD\nA-->B', 'sequenceDiagram\nA->>B: hello', 'classDiagram\nclass A', 'stateDiagram-v2\n[*] --> A', 'gantt\ntitle Demo']) assert.equal(isMermaidSource(source), true);
  assert.equal(isMermaidSource('any incomplete diagram', 'MERMAID'), true);
  assert.equal(isMermaidSource('flowchart TD\nA-->B', 'text'), false);
  assert.equal(isMermaidSource('Here is a flowchart TD example'), false);
});
