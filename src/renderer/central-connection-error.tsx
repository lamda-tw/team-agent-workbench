import React from 'react';
import { needsCentralConnection } from '../shared/central-connection';

export function CentralReconnectAction({ message, reconnect }: { message: string; reconnect: () => void }) {
  return needsCentralConnection(message) ? <button type="button" className="secondary compact" onClick={reconnect}>重新连接中央节点</button> : null;
}

export function CentralConnectionError({ message, reconnect }: { message: string; reconnect: () => void }) {
  return <div className="inline-error central-connection-error" role="alert"><span>{message}</span><CentralReconnectAction message={message} reconnect={reconnect}/></div>;
}
