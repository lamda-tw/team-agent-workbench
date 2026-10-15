import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { cursorIdePage } from '../src/core/cursor-ide-page';

// Isolated synthetic DOM contract tests. Never connects to a real Cursor window,
// reads a personal profile, starts a CLI, or sends a model request.
async function main(){
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage();
    await page.evaluate('window.__name = fn => fn');
    const nativeId='11111111-1111-4111-8111-111111111111',cwd='D:/test workspace',token='test-anchor';
    await page.setContent(`<div data-composer-id="${nativeId}" data-composer-status="completed"><div contenteditable="true" role="textbox"></div><div data-stop-button="true" hidden>Stop</div></div><div data-message-id="previous" data-message-kind="human">previous</div>`);
    await page.evaluate(()=>{(window as any).vscode={context:{resolveConfiguration:async()=>({workspace:{uri:{scheme:'file',path:'/D:/test workspace'}}})}};(window as any).sent=0;document.querySelector('[contenteditable]')!.addEventListener('keydown',(event:any)=>{if(event.key!=='Enter')return;event.preventDefault();(window as any).sent++;const node=document.createElement('div');node.dataset.messageId='new-native-user';node.dataset.messageKind='human';node.innerText=event.target.innerText;document.body.append(node);event.target.innerText='';});});
    const call=(operation:string,extra:object={})=>page.evaluate(`(()=>{const __name=fn=>fn;return (${cursorIdePage.toString()})(${JSON.stringify({operation,id:nativeId,cwd,token,...extra})})})()`);
    assert.equal((await call('catalog')).chats[0].nativeId,nativeId);
    await assert.rejects(call('snapshot',{cwd:'D:/another workspace'}),/工作目录/);
    await page.locator('[contenteditable]').fill('native unsent draft');await assert.rejects(call('prepareSend'),/草稿/);assert.equal(await page.locator('[contenteditable]').innerText(),'native unsent draft');
    await page.locator('[contenteditable]').fill('');await call('prepareSend');await page.locator('[contenteditable]').fill('actual message');
    await call('checkSend',{text:'actual message'});await call('submit',{text:'actual message'});
    assert.equal((await call('receipt',{text:'actual message'})).nativeMessageId,'new-native-user');assert.equal(await page.evaluate(()=>(window as any).sent),1);
    await call('release');await assert.rejects(call('submit',{text:''}),/输入状态/);
    await page.locator('[data-composer-id]').evaluate(node=>node.setAttribute('data-composer-status','applying'));await assert.rejects(call('prepareSend'),/回复/);
    await page.locator('[data-composer-id]').evaluate(node=>node.setAttribute('data-composer-status','completed'));
    await page.evaluate(()=>{const container=document.createElement('div');container.className='notifications-toasts';container.innerHTML='<div class="notification-toast-container"><div role="dialog">Optional Git repository notification</div></div>';document.body.append(container);});
    assert.equal((await call('snapshot')).status,'completed','a nonmodal VS Code notification must not suspend the send queue');
    await call('prepareSend');await call('release');
    await page.locator('.notifications-toasts [role=dialog]').evaluate(node=>node.setAttribute('aria-modal','true'));
    assert.equal((await call('snapshot')).status,'approval','an explicitly modal prompt remains blocking even inside a notification container');
    await assert.rejects(call('prepareSend'),/弹窗/);await page.locator('.notifications-toasts').evaluate(node=>node.remove());
    await page.evaluate(()=>{const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.innerText='Native confirmation';document.body.append(dialog);});
    assert.equal((await call('snapshot')).status,'approval');await assert.rejects(call('prepareSend'),/弹窗/);await assert.rejects(call('stop'),/弹窗/);
    await page.locator('[role=dialog]').evaluate(node=>node.remove());await call('prepareSend');await page.locator('[contenteditable]').fill('never submit to another chat');
    await page.locator('[data-composer-id]').evaluate(node=>node.setAttribute('data-composer-id','22222222-2222-4222-8222-222222222222'));
    await assert.rejects(call('submit',{text:'never submit to another chat'}),/关联会话/);assert.equal(await page.evaluate(()=>(window as any).sent),1);
    console.log('IDE DOM guards passed: exact workspace/chat, native drafts, applying barrier, modal barrier, scoped single send, receipt identity and stale anchor rejection. No real Cursor or model used.');
  }finally{await browser.close();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
