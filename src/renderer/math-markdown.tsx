import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

const standaloneEnvironment = /^\s*\\begin\{(equation\*?|align\*?|aligned|gather\*?|gathered|multline\*?|flalign\*?|alignat\*?|split|cases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|array)\}/;

function isClosingFence(line: string, marker: string) {
  const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
  return !!closing && closing[0] === marker[0] && closing.length >= marker.length;
}

function unwrapFormula(source: string) {
  const trimmed = source.trim();
  for (const pattern of [/^\$\$\s*([\s\S]*?)\s*\$\$$/, /^\\\[\s*([\s\S]*?)\s*\\\]$/, /^\\\(\s*([\s\S]*?)\s*\\\)$/]) {
    const match = pattern.exec(trimmed);
    if (match) return match[1];
  }
  return trimmed;
}

// Math-labelled fences are a common model output. Leave incomplete fences and
// complete TeX documents as source code, so streamed output remains legible.
function expandMathFences(source: string) {
  const lines = source.split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const opening = /^( {0,3})(`{3,}|~{3,})\s*(math|latex|tex)\s*$/i.exec(lines[index]);
    if (!opening) {
      const ordinary = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index])?.[1];
      if (ordinary) {
        const end = lines.findIndex((line, offset) => offset > index && isClosingFence(line, ordinary));
        if (end !== -1) {
          output.push(...lines.slice(index, end + 1));
          index = end + 1;
          continue;
        }
        output.push(...lines.slice(index));
        break;
      }
      output.push(lines[index++]);
      continue;
    }
    const end = lines.findIndex((line, offset) => offset > index && isClosingFence(line, opening[2]));
    if (end === -1) {
      // remark-math treats even an unfinished ```math fence as display math.
      // Keep its source visible until the closing fence arrives.
      output.push(lines[index].replace(/(math|latex|tex)\s*$/i, 'math-source'), ...lines.slice(index + 1));
      break;
    }
    const body = lines.slice(index + 1, end).join('\n');
    if (/\\(?:documentclass\b|usepackage\b|begin\{document\})/.test(body) || !body.trim()) {
      output.push(lines[index].replace(/(math|latex|tex)\s*$/i, 'math-source'), ...lines.slice(index + 1, end + 1));
    } else {
      output.push('', `${opening[1]}$$`, unwrapFormula(body), `${opening[1]}$$`, '');
    }
    index = end + 1;
  }
  return output.join('\n');
}

function wrapStandaloneEnvironments(source: string) {
  const lines = source.split('\n');
  const output: string[] = [];
  let fence: string | undefined;
  let displayMath = false;
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (isClosingFence(line, fence)) fence = undefined;
      output.push(line);
      index++;
      continue;
    }
    if (fence) {
      output.push(line);
      index++;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      displayMath = !displayMath;
      output.push(line);
      index++;
      continue;
    }
    const environment = displayMath ? undefined : standaloneEnvironment.exec(line)?.[1];
    if (!environment) {
      output.push(line);
      index++;
      continue;
    }
    const endTag = `\\end{${environment}}`;
    let end = -1;
    let nestedFence: string | undefined;
    for (let candidateIndex = index; candidateIndex < lines.length; candidateIndex++) {
      const candidate = lines[candidateIndex];
      const candidateMarker = /^ {0,3}(`{3,}|~{3,})/.exec(candidate)?.[1];
      if (candidateMarker) {
        if (!nestedFence) nestedFence = candidateMarker;
        else if (isClosingFence(candidate, nestedFence)) nestedFence = undefined;
        continue;
      }
      if (!nestedFence && candidate.includes(endTag)) {
        end = candidateIndex;
        break;
      }
    }
    if (end === -1) {
      output.push(line);
      index++;
      continue;
    }
    const indent = /^\s*/.exec(line)?.[0] || '';
    output.push('', `${indent}$$`, ...lines.slice(index, end + 1), `${indent}$$`, '');
    index = end + 1;
  }
  return output.join('\n');
}

function normalizeMath(source: string) {
  let fence: { marker: string; length: number } | undefined;
  let codeTicks = 0;
  let bracketMath: 'inline' | 'display' | undefined;
  let offset = 0;
  source = wrapStandaloneEnvironments(expandMathFences(source));
  return source.split('\n').map(line => {
    const lineStart = offset;
    offset += line.length + 1;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !codeTicks && !bracketMath) {
      if (!fence) fence = { marker: marker[0], length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length) fence = undefined;
      return line;
    }
    if (fence) return line;
    let converted = '';
    for (let index = 0; index < line.length;) {
      if (line[index] === '`') {
        const ticks = /^`+/.exec(line.slice(index))![0];
        if (!codeTicks) codeTicks = ticks.length;
        else if (ticks.length === codeTicks) codeTicks = 0;
        converted += ticks;
        index += ticks.length;
        continue;
      }
      const delimiter = line.slice(index, index + 2);
      if (!codeTicks && line[index - 1] !== '\\') {
        if (!bracketMath && delimiter === '\\(' && line.indexOf('\\)', index + 2) !== -1) {
          converted += '$'; bracketMath = 'inline'; index += 2; continue;
        }
        if (bracketMath === 'inline' && delimiter === '\\)') {
          converted += '$'; bracketMath = undefined; index += 2; continue;
        }
        if (!bracketMath && delimiter === '\\[' && source.indexOf('\\]', lineStart + index + 2) !== -1) {
          converted += '$$'; bracketMath = 'display'; index += 2; continue;
        }
        if (bracketMath === 'display' && delimiter === '\\]') {
          converted += '$$'; bracketMath = undefined; index += 2; continue;
        }
      }
      converted += line[index++];
    }
    const math = /^(\s*)\$\$(.+?)\$\$\s*$/.exec(converted);
    return math && !math[2].includes('$$') ? `${math[1]}$$\n${math[1]}${math[2]}\n${math[1]}$$` : converted;
  }).join('\n');
}

// Keep each existing Markdown view's plugins and components while giving all
// user- and agent-authored content the same math rendering behavior.
export default function MathMarkdown({ remarkPlugins, rehypePlugins, children, ...props }: ComponentProps<typeof ReactMarkdown>) {
  return <ReactMarkdown
    {...props}
    remarkPlugins={[remarkMath, ...(remarkPlugins || [])]}
    rehypePlugins={[rehypeKatex, ...(rehypePlugins || [])]}
  >{normalizeMath(children || '')}</ReactMarkdown>;
}
