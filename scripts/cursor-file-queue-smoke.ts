import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

// Isolated product-component test. No native Cursor, account, CLI or model.
async function main() {
const output = path.resolve('.test-data', 'cursor-file-queue-ui-' + Date.now());
await fs.mkdir(output, { recursive: true });
const component = path.resolve('src/renderer/cursor-native-record').replaceAll('\\', '/');
const styles = path.resolve('src/renderer/styles.css').replaceAll('\\', '/');
await fs.writeFile(path.join(output, 'entry.tsx'), `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{CursorNativeQueue}from'${component}';import'${styles}';
function App(){const[session,setSession]=useState({id:'workbench-session',messages:[]});
window.showSession=setSession;return <CursorNativeQueue session={session}/>;}
createRoot(document.getElementById('root')).render(<App/>);`);
await build({entryPoints:[path.join(output,'entry.tsx')],bundle:true,outfile:path.join(output,'ui.js'),platform:'browser',jsx:'automatic'});
await fs.writeFile(path.join(output,'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script></html>');
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage(), errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript('window.calls=[];window.workbench={call:async(action,payload)=>{window.calls.push({action,payload});return true;}};');
  await page.goto(pathToFileURL(path.join(output,'index.html')).href);
  const show=async(extra:unknown)=>page.evaluate(value=>(window as any).showSession({id:'workbench-session',messages:[],...value as any}),extra);
  // A lost HTTP response must remain actionable even without a queue snapshot.
  await show({cursorPendingSubmission:{id:'pending-id',text:'unconfirmed prompt'}});
  await expect(page.getByText('提交结果待确认',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'重新确认提交',exact:true}).click();
  await page.getByRole('button',{name:'取消这次提交',exact:true}).click();
  await show({cursorQueue:{paused:true,requests:[{id:'uncertain-id',text:'check native receipt',state:'uncertain',candidates:['native-message-id']}]}});
  await expect(page.getByRole('button',{name:'继续等待队列'})).toBeDisabled();
  await page.getByRole('button',{name:'确认已在原生会话中发送'}).click();
  await page.getByRole('button',{name:'核对后结束此请求'}).click();
  await show({cursorQueue:{paused:true,requests:[{id:'queued-id',text:'waiting prompt',state:'queued'}]}});
  await page.getByRole('button',{name:'取消等待',exact:true}).click();
  await page.getByRole('button',{name:'继续等待队列'}).click();
  const calls=await page.evaluate(()=>(window as any).calls);
  assert.deepEqual(calls.map((call:any)=>call.payload.action),['confirm','withdraw','reconcile','reconcile','cancel','resume']);
  assert.ok(calls.every((call:any)=>call.action==='session.cursorNative.queue'&&call.payload.id==='workbench-session'));
  assert.equal(calls[2].payload.requestId,'uncertain-id');assert.equal(calls[2].payload.nativeMessageId,'native-message-id');
  assert.equal(calls[3].payload.nativeMessageId,undefined);assert.equal(calls[4].payload.requestId,'queued-id');
  await show({messages:[{nativeItemId:'native-id'}],cursorQueue:{paused:false,requests:[{id:'accepted-id',text:'already in canonical history',state:'accepted',nativeMessageId:'native-id'}]}});
  await expect(page.getByRole('region')).toHaveCount(0);
  await expect(page.getByText('already in canonical history')).toHaveCount(0);
  await show({cursorQueue:{paused:false,requests:[]}});
  await expect(page.locator('.cursor-native-queue')).toHaveCount(0);
  assert.deepEqual(errors,[]);
  console.log('Cursor queue UI passed: unconfirmed submission recovery, reconciliation, paused queue, cancellation, explicit resume, session-scoped IPC and no duplicate accepted messages. No native app or model used.');
} finally { await browser.close(); }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
