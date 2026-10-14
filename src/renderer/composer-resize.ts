export const MIN_COMPOSER_HEIGHT = 64;
export const DEFAULT_COMPOSER_HEIGHT = 70;
export const COMPOSER_HEIGHT_STEP = 24;

/** Leave room for the toolbar, message list, composer chrome, and status bar. */
export function maxComposerHeight(viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight) {
  return Math.max(MIN_COMPOSER_HEIGHT, Math.min(560, Math.round(viewportHeight - 320)));
}

export function clampComposerHeight(height: number, viewportHeight?: number) {
  return Math.round(Math.min(maxComposerHeight(viewportHeight), Math.max(MIN_COMPOSER_HEIGHT, height)));
}

/** Top-edge drag: moving the pointer up grows a bottom-docked composer. */
export function composerHeightAfterDrag(startHeight: number, startY: number, clientY: number, viewportHeight?: number) {
  return clampComposerHeight(startHeight + (startY - clientY), viewportHeight);
}
