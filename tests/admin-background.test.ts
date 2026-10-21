import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachAdminBackground, type BackgroundControls } from '../src/admin/background-mode';

class Window extends EventEmitter {
  hidden = false; minimized = false; focused = false; destroyed = false;
  isDestroyed() { return this.destroyed; } isMinimized() { return this.minimized; }
  restore() { this.minimized = false; } show() { this.hidden = false; } focus() { this.focused = true; } hide() { this.hidden = true; }
  close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); return prevented; }
}

test('closing the enabled relay window hides it without requesting shutdown; the tray reopens it', () => {
  const window = new Window(); let controls!: BackgroundControls, quit = 0, notices = 0, disposed = 0;
  const background = attachAdminBackground(window, { enabled: () => true, requestQuit() { quit++; }, createTray(value) { controls = value; return { destroy() { disposed++; }, notify() { notices++; } }; } });
  assert.equal(background.available, true); assert.equal(window.close(), true); assert.equal(window.hidden, true); assert.equal(quit, 0);
  assert.equal(window.close(), true); assert.equal(notices, 1);
  window.minimized = true; controls.open(); assert.equal(window.hidden, false); assert.equal(window.minimized, false); assert.equal(window.focused, true);
  controls.quit(); assert.equal(quit, 1); assert.equal(window.close(), false);
  background.dispose(); background.dispose(); assert.equal(disposed, 1);
});

test('disabled relays close normally and shutdown is never intercepted even after re-enabling', () => {
  const window = new Window(); let enabled = false;
  const background = attachAdminBackground(window, { enabled: () => enabled, requestQuit() {}, createTray() { return { destroy() {} }; } });
  assert.equal(window.close(), false); assert.equal(window.hidden, false);
  enabled = true; assert.equal(window.close(), true);
  background.beginQuit(); assert.equal(window.close(), false); background.dispose();
});

test('an unavailable tray never leaves an inaccessible hidden window', () => {
  const window = new Window();
  const background = attachAdminBackground(window, { enabled: () => true, requestQuit() {}, createTray() { throw new Error('tray unavailable'); } });
  assert.equal(background.available, false); assert.equal(window.close(), false); assert.equal(window.hidden, false); background.dispose();
});

test('a failed notification does not close the authenticated background process', () => {
  const window = new Window(); let quit = 0;
  const background = attachAdminBackground(window, { enabled: () => true, requestQuit() { quit++; }, createTray() { return { destroy() {}, notify() { throw new Error('notifications unavailable'); } }; } });
  assert.equal(window.close(), true); assert.equal(window.hidden, true); assert.equal(quit, 0); background.dispose();
});
