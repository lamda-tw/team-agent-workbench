import type { Browser, Page } from 'playwright';
import type { CursorNativeSnapshot } from '../src/core/cursor-native-rpc';

export class CursorNativeUi {
  private acting = false;
  constructor(private browser: Browser, readonly sessionId: string) {}
  private async page(): Promise<Page> {
    const matches: Page[] = [];
    for (const page of this.browser.contexts().flatMap(context => context.pages())) {
      if (await page.locator('[data-composer-id="' + this.sessionId + '"]').filter({ visible: true }).count()) matches.push(page);
    }
    if (matches.length !== 1) throw new Error('请先在 Cursor 原生窗口打开关联的测试会话');
    const page = matches[0];
    if (await page.locator('[data-composer-id]').filter({ visible: true }).count() !== 1) throw new Error('请在 Cursor 中只显示关联会话，再发送');
    return page;
  }
  async snapshot(): Promise<CursorNativeSnapshot> {
    const page = await this.page();
    const composer = page.locator('[data-composer-id="' + this.sessionId + '"]').filter({ visible: true });
    const messages = await page.locator('[data-message-id][data-message-kind="human"], [data-message-id][data-message-kind="assistant"]').filter({ visible: true }).evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-message-id')!, role: node.getAttribute('data-message-kind') === 'human' ? 'user' as const : 'assistant' as const, text: (node as HTMLElement).innerText })));
    const unique = [...new Map(messages.map(message => [message.id, message])).values()];
    return { sessionId: this.sessionId, status: await composer.getAttribute('data-composer-status') || 'unknown', messages: unique };
  }
  async send(text: string) {
    if (this.acting) throw new Error('正在向 Cursor 提交另一条消息，请稍候');
    this.acting = true;
    try {
      const page = await this.page();
      const composer = page.locator('[data-composer-id="' + this.sessionId + '"]').filter({ visible: true });
      if (await composer.getAttribute('data-composer-status') === 'generating') throw new Error('Cursor 原生会话正在运行，未发送');
      const input = composer.locator('[contenteditable=true][role=textbox]');
      if (await input.count() !== 1) throw new Error('无法定位 Cursor 原生输入框，未发送');
      if ((await input.innerText()).replace(/[\u200b\ufeff]/g, '').trim()) throw new Error('Cursor 输入框已有草稿，未覆盖；请先处理原生草稿');
      const priorIds = new Set((await this.snapshot()).messages.map(message => message.id));
      await input.fill(text);
      // Recheck identity immediately before the native send gesture.
      await this.page();
      await input.press('Enter');
      // Observe acceptance for a bounded time; never repeat the send gesture.
      const deadline = Date.now() + 5000;
      let delivered = false;
      while (Date.now() < deadline) {
        const state = await this.snapshot();
        delivered = state.messages.some(message => message.role === 'user' && !priorIds.has(message.id) && message.text.trim() === text.trim());
        if (delivered) break;
        await page.waitForTimeout(100);
      }
      if (!delivered) throw new Error('Cursor 送达状态未确认，请核对原生窗口，避免重复发送');
      return { submitted: true };
    } finally { this.acting = false; }
  }
  async focus() { await (await this.page()).bringToFront(); return {}; }
  async stop() {
    const page = await this.page(), composer = page.locator('[data-composer-id="' + this.sessionId + '"]');
    // Cursor's idle cancel shortcut can reject pending edits. Never invoke it idle.
    if (await composer.getAttribute('data-composer-status') !== 'generating') return {};
    await composer.locator('[contenteditable=true][role=textbox]').focus();
    await this.page();
    await page.keyboard.press('Control+Shift+Backspace'); return {};
  }
}
