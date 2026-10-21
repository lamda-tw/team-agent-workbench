let engine: Promise<typeof import('mermaid')['default']> | undefined;
let nextDiagram = 0;

async function mermaidEngine() {
  return engine ||= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      htmlLabels: false,
      layout: 'dagre',
      maxTextSize: 50_000,
      maxEdges: 500,
      fontFamily: 'Microsoft YaHei, Arial, sans-serif',
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'layout', 'fontFamily'],
      flowchart: { htmlLabels: false, useMaxWidth: false },
      theme: 'neutral',
    });
    return mermaid;
  }).catch(error => { engine = undefined; throw error; });
}

export async function renderMermaid(source: string) {
  if (source.length > 50_000) throw new Error('图表内容过长，请拆分后查看');
  const mermaid = await mermaidEngine();
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-100000px;top:0;width:1200px;visibility:hidden;pointer-events:none';
  document.body.append(container);
  try {
    const { svg } = await mermaid.render('workbench-diagram-' + ++nextDiagram, source, container);
    return svg;
  } finally { container.remove(); }
}
