import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerActions, composerMode } from '../src/renderer/composer-actions';
import { NativeDesktopControls } from '../src/renderer/native-desktop-controls';
import { BetaFeaturesModal } from '../src/renderer/beta-features';
import { NativeSessionPicker } from '../src/renderer/native-sessions';
import { CursorNativeQueue } from '../src/renderer/cursor-native-record';
import { publishToNativeList } from '../src/core/native-publish';
import type { AgentSession } from '../src/shared/types';

const session = (): AgentSession => ({ id:'legacy',nativeId:'original-agent',title:'saved',provider:'cursor',cwd:'D:/work',purpose:'work',createdAt:'2026-10-14T00:00:00Z',status:'idle',messages:[],sources:[],approvals:[],autoUpload:false,handoffPath:'handoff',cursorNative:{managed:true,descriptorFile:'original-descriptor'},desktopSyncState:'connected' });

test('existing Cursor records never advertise full synchronization and the composer refuses send/Enter actions',()=>{
  const s=session(),controls=renderToStaticMarkup(React.createElement(NativeDesktopControls,{session:s,run(){}}));
  assert.match(controls,/旧关联 · 仅查看/);assert.match(controls,/尚未通过完整历史、上下文压缩与恢复的一致性验证/);assert.doesNotMatch(controls,/同步中/);
  const buttons=renderToStaticMarkup(React.createElement(ComposerActions,{session:s,text:'new task',busy:false,send(){throw Error('must not send');},stop(){}}));
  assert.match(buttons,/disabled=""/);assert.match(buttons,/一致性验证/);assert.equal(composerMode(s),'wait');
  s.cursorNative=undefined;assert.equal(composerMode(s),'send','unassociated CLI chats remain usable');
});

test('native IDE Beta is explicitly separate from legacy view-only and CLI sessions',()=>{
  const render=(enabled:boolean)=>renderToStaticMarkup(React.createElement(BetaFeaturesModal,{features:{cursorDesktopSync:enabled},close(){},changed:async()=>{}}));
  const checkbox=(html:string)=>html.match(/<input[^>]*aria-label="开启 Cursor 原生联动"[^>]*>/)?.[0]||'';
  assert.doesNotMatch(checkbox(render(false)),/disabled=""/);assert.doesNotMatch(checkbox(render(true)),/disabled=""/);assert.match(render(true),/保留原生会话打开/);
  const picker=renderToStaticMarkup(React.createElement(NativeSessionPicker,{provider:'cursor',projectId:'project',cursorDesktopBeta:true,close(){},linked(){}}));
  assert.match(picker,/原生会话 · Beta/);assert.match(picker,/普通 IDE 窗口当前打开/);assert.doesNotMatch(picker,/按 Cursor Agents 的项目查看/);
});

test('verified file bindings enable send and queue actions while preserving the native execution owner',()=>{
  const s=session();s.cursorNative!.transport='ide-files-v1';s.status='running';
  assert.equal(composerMode(s),'send');
  const buttons=renderToStaticMarkup(React.createElement(ComposerActions,{session:s,text:'queued task',busy:false,send(){},stop(){}}));
  assert.doesNotMatch(buttons,/disabled=""/);assert.match(buttons,/停止当前任务/);
  const controls=renderToStaticMarkup(React.createElement(NativeDesktopControls,{session:s,run(){}}));
  assert.match(controls,/同步中/);assert.doesNotMatch(controls,/仅查看|尚未通过/);
});

test('unconfirmed HTTP submissions remain recoverable before a first queue snapshot arrives',()=>{
  const s=session();s.cursorNative!.transport='ide-files-v1';
  s.cursorPendingSubmission={id:'unconfirmed-request',text:'one native request'};
  const html=renderToStaticMarkup(React.createElement(CursorNativeQueue,{session:s}));
  assert.match(html,/提交结果待确认/);assert.match(html,/重新确认提交/);assert.match(html,/取消这次提交/);
  assert.match(html,/one native request/);
  s.cursorPendingSubmission=undefined;
  assert.equal(renderToStaticMarkup(React.createElement(CursorNativeQueue,{session:s})), '');
});

test('low-level desktop registration never synthesizes a Cursor model history or writes its session database',async()=>{
  const s=session();s.cursorNative=undefined;const before=JSON.stringify(s);
  await assert.rejects(publishToNativeList(s,'not-a-real-home'),{code:'CURSOR_SHARED_SESSION_UNAVAILABLE'});
  assert.equal(JSON.stringify(s),before);assert.equal(s.nativePath,undefined);
});
