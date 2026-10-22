import React, { createContext, useContext, useEffect, useState } from 'react';
import ReactMarkdown from './math-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink } from 'lucide-react';
import { loadMarkdownImage, markdownImageSource } from './markdown-images';
import { MermaidDiagram } from './mermaid-diagram';
import { isMermaidSource, prepareDiagramMarkdown } from './mermaid-source';

type MarkdownContext = { sessionId?: string; openFile?: (path: string) => void };
const context = createContext<MarkdownContext>({});

function MarkdownLink({ href, children }: React.ComponentPropsWithoutRef<'a'>) {
  const { openFile } = useContext(context);
  return <a href={href} title={href} onClick={event => { event.preventDefault(); if (href && /^https?:/i.test(href)) void window.workbench.call('open.link', href); else if (href && !href.startsWith('#')) openFile?.(href); }}>{children}<ExternalLink size={11}/></a>;
}

function MarkdownImage({ src, alt, title }: React.ComponentPropsWithoutRef<'img'>) {
  const { sessionId } = useContext(context), source = typeof src === 'string' ? src : '';
  const image = markdownImageSource(source), [attempt, retry] = useState(0);
  const key = JSON.stringify([sessionId, source, attempt]);
  const [loaded, setLoaded] = useState<{ key: string; url?: string; error?: string }>(), [failed, setFailed] = useState<string>();
  useEffect(() => {
    if (markdownImageSource(source).kind !== 'local' || !sessionId) return;
    let active = true;
    void loadMarkdownImage(source, sessionId, (id, path) => window.workbench.call('session.file.preview', { id, path })).then(
      url => { if (active) setLoaded({ key, url }); },
      error => { if (active) setLoaded({ key, error: error instanceof Error ? error.message : '图片读取失败' }); },
    );
    return () => { active = false; };
  }, [source, sessionId, attempt]);
  const current = loaded?.key === key ? loaded : undefined;
  const url = image.kind === 'direct' ? image.url : current?.url;
  const error = failed === key ? '图片加载失败，请检查文件或网络后重试' : image.kind === 'unsupported' ? '图片地址为空或不受支持' : image.kind === 'local' && !sessionId ? '请在所属会话中查看本机图片' : current?.error;
  return <span className="markdown-image-block">{url && !error ? <img key={key} src={url} alt={alt || '图片'} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(key)}/> : <span className="markdown-image-status" role="status"><span>{error ? `无法显示图片：${alt || '附件'}` : `正在加载图片：${alt || '附件'}`}</span>{error && <><small>{error}</small>{image.kind !== 'unsupported' && (image.kind === 'direct' || sessionId) && <button type="button" className="text-button" onClick={() => retry(value => value + 1)}>重试加载图片</button>}</>}</span>}</span>;
}

function MarkdownPre({ children }: React.ComponentPropsWithoutRef<'pre'>) {
  if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(children)) {
    const { className, children: content } = children.props;
    const language = /\blanguage-([^\s]+)/.exec(className || '')?.[1];
    if (typeof content === 'string' && isMermaidSource(content, language)) return <MermaidDiagram source={content.replace(/\n$/, '')}/>;
  }
  return <pre>{children}</pre>;
}

// Stable component identities keep already-loaded images and diagrams mounted as a reply streams.
const components: Components = { a: MarkdownLink, img: MarkdownImage, pre: MarkdownPre };
export function Markdown({ text, openFile, sessionId }: { text: string } & MarkdownContext) {
  return <context.Provider value={{ sessionId, openFile }}><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) => key === 'src' ? markdownImageSource(url).kind === 'unsupported' ? '' : url : /^(https?:|file:|[a-z]:[/\\])/i.test(url) || !/^[a-z][a-z\d+.-]*:/i.test(url) ? url : ''} components={components}>{prepareDiagramMarkdown(text)}</ReactMarkdown></div></context.Provider>;
}
