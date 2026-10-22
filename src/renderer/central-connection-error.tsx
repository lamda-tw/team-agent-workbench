import React from 'react';
import { needsCentralConnection } from '../shared/central-connection';

export function CentralReconnectAction({ message, reconnect }: { message: string; reconnect: () => void }) {
  return needsCentralConnection(message) ? <button type="button" className="text-button central-connection-link" onClick={reconnect}>查看连接</button> : null;
}

export function CentralConnectionError({ message, reconnect }: { message: string; reconnect: () => void }) {
  return <div className="inline-error central-connection-error" role="alert"><span>{message}</span><CentralReconnectAction message={message} reconnect={reconnect}/></div>;
}
