import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/renderer/markdown';
import { loadMarkdownImage, markdownImageSource } from '../src/renderer/markdown-images';
import { previewSessionFile } from '../src/core/session-files';
import type { AgentSession, FilePreview } from '../src/shared/types';

// Opaque test bytes: no real image files or network requests are needed.
const data = 'data:image/png;base64,' + Buffer.from('synthetic fixture').toString('base64');
const image = (extra: Partial<FilePreview> = {}): FilePreview => ({ name: '图片.png', path: '图片.png', type: 'image', size: 100, truncated: false, content: data, ...extra });

test('Markdown renders web and embedded images while retaining links and code blocks', () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, { text: `![图表](https://example.test/chart.png "图表说明")\n\n![内嵌](${data})\n\n[报告](<D:/工作目录/报告.md:12>)\n\n\`\`\`md\n![示例](example.png)\n\`\`\`` }));
  assert.match(html, /<img[^>]*src="https:\/\/example.test\/chart.png"[^>]*alt="图表"[^>]*title="图表说明"/);
  assert.match(html, /referrerPolicy="no-referrer"/i);
  assert(html.includes(`src="${data}"`));
  assert(html.includes(`href="${encodeURI('D:/工作目录/报告.md:12')}"`));
  assert.match(html, /<code class="language-md">!\[示例\]\(example.png\)/);
  assert.equal((html.match(/<img\b/g) || []).length, 2);
  assert(!html.includes('[图片：'));
});

test('local Markdown images use their session context and never emit raw file URLs', () => {
  for (const source of ['plots/结果%20图.png', 'D:/工作目录/结果.png', 'file:///D:/work/chart.png']) {
    const html = renderToStaticMarkup(React.createElement(Markdown, { text: `![结果](${source})`, sessionId: 'session-a' }));
    assert.match(html, /正在加载图片：结果/);
    assert(!html.includes('<img'));
    assert(!html.includes('src="file:'));
  }
  const html = renderToStaticMarkup(React.createElement(Markdown, { text: '![图表](chart.png)' }));
  assert.match(html, /请在所属会话中查看本机图片/);
});

test('image sources accept local paths but reject scripts, HTML payloads and network files', () => {
  for (const source of ['plots/chart.png', '/workspace/图表.png', 'D:\\工作目录\\图表.png', 'file:///D:/work/chart.png']) assert.equal(markdownImageSource(source).kind, 'local');
  for (const source of ['https://example.test/图表.png', 'http://127.0.0.1/chart', data]) assert.equal(markdownImageSource(source).kind, 'direct');
  for (const source of ['', 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:run', '\\\\server\\share\\chart.png', '//server/share/chart.png', 'https://', 'chart\u0000.png']) assert.equal(markdownImageSource(source).kind, 'unsupported');
  const html = renderToStaticMarkup(React.createElement(Markdown, { text: '![不安全](javascript:alert)\n\n[不安全](data:text/html,hello)', sessionId: 's' }));
  assert(!html.includes('src="javascript:'));
  assert(!html.includes('href="data:'));
});

test('local image loading uses the existing checked file preview and preserves its errors', async () => {
  const requests: unknown[] = [];
  const preview = async (id: string, target: string) => { requests.push([id, target]); return image(); };
  assert.equal(await loadMarkdownImage('plots/结果%20图.png', 'session-a', preview), data);
  assert.deepEqual(requests, [['session-a', 'plots/结果%20图.png']]);
  assert.equal(await loadMarkdownImage('https://example.test/chart.png', 'session-a', preview), 'https://example.test/chart.png');
  assert.equal(await loadMarkdownImage(data, 'session-a', preview), data);
  assert.equal(requests.length, 1, 'web and embedded images do not invoke local file access');
  await assert.rejects(loadMarkdownImage('chart.png', undefined, preview), /所属会话/);
  await assert.rejects(loadMarkdownImage('javascript:alert', 's', preview), /不受支持/);
  await assert.rejects(loadMarkdownImage('chart.png', 's', async () => { throw new Error('文件不存在或已移动'); }), /文件不存在或已移动/);
  await assert.rejects(loadMarkdownImage('chart.png', 's', async () => image({ size: 5 * 1024 * 1024 + 1 })), /超过 5 MB/);
  for (const file of [image({ type: 'text' }), image({ truncated: true }), image({ content: 'data:text/html;base64,PHNjcmlwdD4=' })]) await assert.rejects(loadMarkdownImage('chart.png', 's', async () => file), /不是可预览的图片/);
});

test('session preview can return SVG as image data without opening any real image files', async t => {
  const target = path.resolve('synthetic-chart.svg'), bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  t.mock.method(fs, 'stat', async () => ({ isFile: () => true, size: bytes.length }));
  const read = t.mock.method(fs, 'readFile', async () => bytes);
  const session = { cwd: path.dirname(target), messages: [] } as unknown as AgentSession;
  const result = await previewSessionFile(session, target);
  assert.equal(result.type, 'image');
  assert.equal(result.content, 'data:image/svg+xml;base64,' + bytes.toString('base64'));
  assert.equal(read.mock.calls.length, 1);
  assert.equal(read.mock.calls[0].arguments[0], target);
});

test('the renderer permits web image loading while keeping script and connection restrictions', async () => {
  const html = await fs.readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  assert.match(html, /img-src 'self' data: https: http:;/);
  assert.match(html, /script-src 'self';/);
  assert.match(html, /connect-src 'none';/);
});
