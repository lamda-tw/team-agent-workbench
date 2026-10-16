import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink } from 'lucide-react';

export function Markdown({ text, openFile }: { text: string; openFile?: (path: string) => void }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={url => /^(https?:|file:|[a-z]:[/\\])/i.test(url) || !/^[a-z][a-z\d+.-]*:/i.test(url) ? url : ''} components={{ a: ({ href, children }) => <a href={href} title={href} onClick={e => { e.preventDefault(); if (href && /^https?:/i.test(href)) void window.workbench.call('open.link', href); else if (href && !href.startsWith('#')) openFile?.(href); }}>{children}<ExternalLink size={11}/></a>, img: ({ alt }) => <span>[图片：{alt || '附件'}]</span> }}>{text}</ReactMarkdown></div>;
}
