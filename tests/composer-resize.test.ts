import test from 'node:test';
import assert from 'node:assert/strict';
import { clampComposerHeight, composerHeightAfterDrag, DEFAULT_COMPOSER_HEIGHT, MIN_COMPOSER_HEIGHT } from '../src/renderer/composer-resize';

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
