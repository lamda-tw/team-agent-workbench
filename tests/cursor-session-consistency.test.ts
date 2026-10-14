import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerActions, composerMode } from '../src/renderer/composer-actions';
import { NativeDesktopControls } from '../src/renderer/native-desktop-controls';
import { BetaFeaturesModal } from '../src/renderer/beta-features';
import { NativeSessionPicker } from '../src/renderer/native-sessions';
import { publishToNativeList } from '../src/core/native-publish';
import type { AgentSession } from '../src/shared/types';

const session = (): AgentSession => ({ id:'legacy',nativeId:'original-agent',title:'saved',provider:'cursor',cwd:'D:/work',purpose:'work',createdAt:'2026-10-14T00:00:00Z',status:'idle',messages:[],sources:[],approvals:[],autoUpload:false,handoffPath:'handoff',cursorNative:{managed:true,descriptorFile:'original-descriptor'},desktopSyncState:'connected' });

test('existing Cursor records never advertise full synchronization and the composer refuses send/Enter actions',()=>{
  const s=session(),controls=renderToStaticMarkup(React.createElement(NativeDesktopControls,{session:s,run(){}}));
  assert.match(controls,/仅查看已加载记录/);assert.match(controls,/无法让 CLI 与 Agents 共用完整历史和上下文/);assert.doesNotMatch(controls,/同步中/);
  const buttons=renderToStaticMarkup(React.createElement(ComposerActions,{session:s,text:'new task',busy:false,send(){throw Error('must not send');},stop(){}}));
  assert.match(buttons,/disabled=""/);assert.match(buttons,/共用完整历史和上下文/);assert.equal(composerMode(s),'wait');
  s.cursorNative=undefined;assert.equal(composerMode(s),'send','unassociated CLI chats remain usable');
});

test('unavailable Beta cannot be enabled, existing preferences can be disabled and the CLI picker does not promise desktop continuity',()=>{
  const render=(enabled:boolean)=>renderToStaticMarkup(React.createElement(BetaFeaturesModal,{features:{cursorDesktopSync:enabled},close(){},changed:async()=>{}}));
  const checkbox=(html:string)=>html.match(/<input[^>]*aria-label="开启 Cursor Agents 联动"[^>]*>/)?.[0]||'';
  assert.match(checkbox(render(false)),/disabled=""/);assert.doesNotMatch(checkbox(render(true)),/disabled=""/);assert.match(render(true),/旧关联仅查看/);
  const picker=renderToStaticMarkup(React.createElement(NativeSessionPicker,{provider:'cursor',projectId:'project',cursorDesktopBeta:true,close(){},linked(){}}));
  assert.match(picker,/CLI 会话与 Cursor Agents 独立/);assert.match(picker,/Agents 会话（暂不可关联）/);assert.doesNotMatch(picker,/按 Cursor Agents 的项目查看/);
});

test('low-level desktop registration never synthesizes a Cursor model history or writes its session database',async()=>{
  const s=session();s.cursorNative=undefined;const before=JSON.stringify(s);
  await assert.rejects(publishToNativeList(s,'not-a-real-home'),{code:'CURSOR_SHARED_SESSION_UNAVAILABLE'});
  assert.equal(JSON.stringify(s),before);assert.equal(s.nativePath,undefined);
});
