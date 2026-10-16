import React, { useState } from 'react';
import type { AgentSession, Message } from '../shared/types';

export function CursorNativeRecord({ message }: { message: Message }) {
  if (!message.nativeDetails) return null;
  const details=message.nativeDetails;
  return <details className="native-record"><summary>{details.toolCall?'原生工具记录':details.error?'原生错误记录':'原生思考记录'}</summary><pre>{JSON.stringify(details,null,2)}</pre></details>;
}

export function CursorNativeQueue({ session }: { session: AgentSession }) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const queue=session.cursorQueue||{paused:false,requests:[]};
  const pending=queue.requests.filter(request=>['queued','sending','uncertain'].includes(request.state)||request.state==='accepted'&&!session.messages.some(message=>message.nativeItemId===request.nativeMessageId));
  if(!pending.length&&!queue.paused&&!session.cursorPendingSubmission)return null;
  const waiting=queue.paused?'等待继续队列':session.desktopSyncState!=='connected'?'等待关联会话连接，可点击“在 Cursor 中打开”':session.cursorSettings?.pending||session.cursorSettings?.state==='unavailable'?'等待原生设置确认':session.status==='running'?'等待前一轮结束':'等待原生会话就绪';
  const act=async(action:string,requestId?:string,nativeMessageId?:string)=>{setBusy(true);setError('');try{await window.workbench.call('session.cursorNative.queue',{id:session.id,action,requestId,nativeMessageId});}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  return <section className="cursor-native-queue" aria-label="Cursor 等待队列"><div className="row"><b>{queue.paused?'等待队列已暂停':'等待与执行'}</b>{queue.paused&&<button className="secondary compact" disabled={busy||pending.some(request=>request.state==='uncertain')} onClick={()=>void act('resume')}>继续等待队列</button>}</div>{session.cursorPendingSubmission&&<div className="native-queue-item"><b>提交结果待确认</b><p>{session.cursorPendingSubmission.text}</p><button className="secondary compact" disabled={busy} onClick={()=>void act('confirm')}>重新确认提交</button><button className="text-button" disabled={busy} onClick={()=>void act('withdraw')}>取消这次提交</button></div>}{pending.map(request=><div className="native-queue-item" key={request.id}><span>{request.state==='queued'?waiting:request.state==='sending'?'正在送达':request.state==='accepted'?'原生已接收':'送达待核对'}</span><p>{request.text}</p>{request.state==='queued'&&<button className="text-button" disabled={busy} onClick={()=>void act('cancel',request.id)}>取消等待</button>}{request.state==='uncertain'&&<><p>{request.error||'请核对原生窗口。此请求不会自动重发。'}</p>{request.candidates?.length===1&&<button className="secondary compact" disabled={busy} onClick={()=>void act('reconcile',request.id,request.candidates![0])}>确认已在原生会话中发送</button>}<button className="text-button" disabled={busy} onClick={()=>void act('reconcile',request.id)}>核对后结束此请求</button></>}</div>)}{error&&<p className="inline-error" role="alert">{error}</p>}</section>;
}
