import test from 'node:test';
import assert from 'node:assert/strict';
import { clampComposerHeight, composerHeightAfterDrag, DEFAULT_COMPOSER_HEIGHT, MIN_COMPOSER_HEIGHT, QUESTION_COMPOSER_DEFAULT, QUESTION_COMPOSER_MAX, QUESTION_COMPOSER_MIN, questionComposerHeightAfterDrag } from '../src/renderer/composer-resize';

const viewport = 900;

test('dragging the composer top edge upward makes the input taller', () => {
  assert.equal(composerHeightAfterDrag(DEFAULT_COMPOSER_HEIGHT, 400, 320, viewport), 150);
});

test('dragging the composer top edge downward makes the input shorter', () => {
  assert.equal(composerHeightAfterDrag(150, 320, 400, viewport), DEFAULT_COMPOSER_HEIGHT);
});

test('composer height stays within the readable range', () => {
  assert.equal(composerHeightAfterDrag(DEFAULT_COMPOSER_HEIGHT, 100, 400, viewport), MIN_COMPOSER_HEIGHT);
  assert.equal(clampComposerHeight(2000, viewport), 560);
  assert.equal(clampComposerHeight(10, 400), MIN_COMPOSER_HEIGHT);
});

test('question follow-up grows upward and stays within its own range', () => {
  assert.equal(questionComposerHeightAfterDrag(QUESTION_COMPOSER_DEFAULT, 400, 320), 152);
  assert.equal(questionComposerHeightAfterDrag(152, 320, 400), QUESTION_COMPOSER_DEFAULT);
  assert.equal(questionComposerHeightAfterDrag(QUESTION_COMPOSER_DEFAULT, 0, 400), QUESTION_COMPOSER_MIN);
  assert.equal(questionComposerHeightAfterDrag(QUESTION_COMPOSER_DEFAULT, 400, 0), QUESTION_COMPOSER_MAX);
});
