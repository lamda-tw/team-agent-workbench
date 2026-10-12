import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { preparationDirectionsSchema, selectedPreparationDirections } from '../src/shared/preparation-directions';
import { preparationPrompt } from '../src/core/preparation-prompt';
import { contributionCategoryInfo } from '../src/shared/content';
import type { PreparationCategory } from '../src/shared/result-rules';
import type { AgentSession, Draft } from '../src/shared/types';

test('directions trim whitespace without losing paragraphs, ignore unselected categories and validate input', () => {
  for (const blank of ['', ' ', '\t', '\r\n', ' \t\n\r ', '\u3000\u00a0']) {
    assert.deepEqual(selectedPreparationDirections(['exploration'], { exploration: blank }), {});
  }
  const input = { exploration: ' \t保留验证边界\n\n略过重复信息\r\n ', todo: '不应传入' };
  assert.deepEqual(selectedPreparationDirections(['exploration'], input), { exploration: '保留验证边界\n\n略过重复信息' });
  assert.equal(input.exploration, ' \t保留验证边界\n\n略过重复信息\r\n ');
  assert.deepEqual(selectedPreparationDirections(['exploration'], undefined), {});
  assert.equal(preparationDirectionsSchema.safeParse({ exploration: '字'.repeat(4001) }).success, false);
  assert.equal(preparationDirectionsSchema.safeParse({ exploration: 123 }).success, false);
  assert.equal(preparationDirectionsSchema.safeParse({ unknown: '不支持的类别' }).success, false);
});

test('blank directions leave the default prompt unchanged; custom directions apply only to selected categories and never to merges', () => {
  const draft = { inputDir: '/frozen', resultRules: { contract: 2, categories: ['exploration', 'capability'] } } as Draft;
  const original = preparationPrompt(draft, []), merge = preparationPrompt(draft, [], true);
  draft.preparationDirections = { exploration: ' \t\r\n ', capability: '\u3000', todo: '未勾选的方向' };
  assert.equal(preparationPrompt(draft, []), original);
  draft.preparationDirections.exploration = ' \t重点解释性能的适用条件\n保留尚未验证的范围 ';
  const prompt = preparationPrompt(draft, []);
  assert(prompt.includes(JSON.stringify({ exploration: '重点解释性能的适用条件\n保留尚未验证的范围' })));
  assert(!prompt.includes('未勾选的方向'));
  assert(prompt.includes('未提供方向的类别使用默认提示词'));
  assert(prompt.includes('不得为了满足方向编造材料中没有的信息'));
  assert.equal(preparationPrompt(draft, [], true), merge);
  const profile = preparationPrompt({ ...draft, resultRules: { contract: 4, categories: ['exploration', 'capability'] } }, []);
  assert(profile.includes('每个项目只整理一条'));
  assert(!profile.includes('重点解释性能的适用条件'));
});

test('category controls expose one multiline field per checked category, with defaults and reorganization directions', async () => {
  // Renderer modules capture the bridge on import; this test does not launch a desktop.
  const previous = (globalThis as any).window;
  (globalThis as any).window = { workbench: {} };
  try {
    const { PreparationCategoryChoices, PreparationOptionsModal } = await import('../src/renderer/preparation-options');
    const categories: PreparationCategory[] = ['exploration', 'capability', 'todo'];
    const directions = { exploration: '关注精度与性能边界', todo: '保留未解决的阻塞项' };
    const render = (selected: PreparationCategory[]) => renderToStaticMarkup(createElement(PreparationCategoryChoices, { categories, selected, directions, disabled: false, select: () => {}, changeDirection: () => {} }));
    const html = render(['exploration', 'capability']);
    assert.equal((html.match(/type="checkbox"/g) || []).length, 3);
    assert.equal((html.match(/<textarea /g) || []).length, 2);
    assert(html.includes('rows="3"'));
    assert(html.includes(`aria-label="${contributionCategoryInfo.exploration.label}的整理方向"`));
    assert(html.includes('关注精度与性能边界'));
    assert(html.includes('留空使用默认提示词'));
    assert(!html.includes('保留未解决的阻塞项'));
    assert(render(['todo']).includes('保留未解决的阻塞项'));
    assert(!render([]).includes('<textarea'));
    const again = renderToStaticMarkup(createElement(PreparationOptionsModal, {
      session: { id: 'session', title: '会话', messages: [] } as unknown as AgentSession, initialDirections: directions, again: true, close: () => {}, started: async () => {},
    }));
    assert(again.includes('再次整理成果'));
    assert(again.includes('恰好一句话，说明这是个什么项目。'));
    assert(again.includes('用什么标准判断这些成果算达到。'));
    assert(!again.includes('关注精度与性能边界'));
  } finally { (globalThis as any).window = previous; }
});
