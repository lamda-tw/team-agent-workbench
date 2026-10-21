type CloseEvent = { preventDefault(): void };
export interface BackgroundWindow {
  on(event: 'close', listener: (event: CloseEvent) => void): unknown;
  isDestroyed(): boolean; isMinimized(): boolean;
  restore(): void; show(): void; focus(): void; hide(): void;
}
export interface BackgroundTray { destroy(): void; notify?(): void }
export interface BackgroundControls { open(): void; quit(): void }

/** Keep the existing relay and authenticated reverse tunnel alive when only the window closes. */
export function attachAdminBackground(window: BackgroundWindow, options: {
  enabled(): boolean;
  createTray(controls: BackgroundControls): BackgroundTray;
  requestQuit(): void;
}) {
  let quitting = false, notified = false;
  let tray: BackgroundTray | undefined;
  const controls: BackgroundControls = {
    open() { if (window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); },
    quit() { quitting = true; options.requestQuit(); },
  };
  try { tray = options.createTray(controls); } catch { /* Without a usable tray, preserve normal close behavior. */ }
  window.on('close', event => {
    if (quitting || !tray || !options.enabled()) return;
    event.preventDefault(); window.hide();
    if (!notified) { notified = true; try { tray.notify?.(); } catch { /* A notification is optional. */ } }
  });
  return {
    available: !!tray,
    beginQuit() { quitting = true; },
    dispose() { quitting = true; const current = tray; tray = undefined; current?.destroy(); },
  };
}
