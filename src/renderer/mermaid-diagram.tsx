import React, { useEffect, useState } from 'react';
import { renderMermaid } from './mermaid-renderer';

export function MermaidDiagram({ source }: { source: string }) {
  const [result, setResult] = useState<{ source: string; svg?: string; error?: string }>(), [zoom, setZoom] = useState(1);
  useEffect(() => {
    let active = true;
    // Replies stream token by token; wait briefly before laying out a new version.
    const timer = setTimeout(() => {
      void renderMermaid(source).then(
        svg => { if (active) setResult({ source, svg }); },
        () => { if (active) setResult({ source, error: '图表语法尚未完整或有误，可展开源码查看。' }); },
      );
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [source]);
  const current = result?.source === source ? result : undefined;
  return <section className="mermaid-diagram" aria-label="Mermaid 图表"><header><b>图表</b>{current?.svg && <span className="row"><button type="button" className="text-button" disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}>缩小</button><button type="button" className="text-button" onClick={() => setZoom(1)}>适应宽度</button><button type="button" className="text-button" disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + 0.25))}>放大</button></span>}</header>{current?.svg ? <div className="mermaid-diagram-viewport"><img className="mermaid-diagram-image" alt="Mermaid 图表" src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(current.svg)} style={{ width: `${zoom * 100}%` }}/></div> : <p className="muted small" role="status">{current?.error || '正在绘制图表…'}</p>}<details open={current?.error ? true : undefined}><summary>查看源码</summary><pre><code>{source}</code></pre></details></section>;
}
