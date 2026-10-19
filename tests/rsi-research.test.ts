import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineRules, development, holdout, extract, evaluate, type Rule } from '../scripts/rsi-research-fixture';
test('algorithm evaluation requires exact UTF-16 spans, penalizes negatives and keeps splits disjoint', () => {
  const improved: Rule[] = [{ label: 'PERSON', pattern: 'Author:\\s*([^;]+);', group: 1, ignoreValues: ['[unknown]', 'N/A'] }, { label: 'ORG', pattern: 'Organization:\\s*(.+)\\.$', group: 1, ignoreValues: ['[unknown]', 'N/A'] }];
  assert.equal(evaluate(development, improved).f1, 1); assert.equal(evaluate(holdout, improved).f1, 1);
  assert(evaluate(holdout, baselineRules).f1 < 0.2);
  assert(!development.some(a => holdout.some(b => a.id === b.id || a.text === b.text)));
  const prediction = extract('Author: Ada Lovelace; Organization: Quantum Labs.', baselineRules)[0];
  assert.equal(prediction.end - prediction.start, 3); assert.equal(evaluate(development, baselineRules).fp > 0, true);
});
