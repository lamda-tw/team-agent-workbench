const diagramStart = /^(?:(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b|(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|sankey-beta|xychart(?:-beta)?|block-beta|packet-beta|architecture-beta|kanban)\b)/;

export function isMermaidSource(text: string, language?: string) {
  if (language) return language.toLowerCase() === 'mermaid';
  return diagramStart.test(text.trimStart());
}

// Some agents emit a standalone diagram without a Markdown code fence.
export function prepareDiagramMarkdown(text: string) {
  const source = text.trim();
  return isMermaidSource(source) && !/^\s*(?:`{3,}|~{3,})/m.test(source) ? '```mermaid\n' + source + '\n```' : text;
}
