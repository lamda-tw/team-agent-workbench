import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import remarkGfm from 'remark-gfm';
import MathMarkdown from '../src/renderer/math-markdown';

function render(text: string) {
  return renderToStaticMarkup(React.createElement(MathMarkdown, { remarkPlugins: [remarkGfm], children: text }));
}

test('renders inline and display LaTeX alongside ordinary Markdown', () => {
  const html = render('**公式** $E=mc^2$\n\n$$\\frac{a}{b}$$');
  assert.match(html, /<strong>公式<\/strong>/);
  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /\\frac\{a\}\{b\}/);
  assert.match(render('$$\n\\frac{a}{b}\n$$'), /class="katex-display"/);
});

test('keeps LaTeX in inline and fenced code as literal source', () => {
  const html = render('`$x^2$` and `\\(x^2\\)`\n\n```text\n$$\\frac{a}{b}$$\n\\[x^2\\]\n```');
  assert.match(html, /<code>\$x\^2\$<\/code>/);
  assert.match(html, /<code class="language-text">/);
  assert.doesNotMatch(html, /class="katex"/);
});

test('renders math, latex, and tex fences, including already-delimited formulas', () => {
  for (const language of ['math', 'latex', 'tex']) {
    const html = render('```' + language + '\n\\frac{\\alpha+\\beta}{\\sqrt{x}}\n```');
    assert.match(html, /class="katex-display"/, language);
    assert.doesNotMatch(html, /katex-error/, language);
  }
  const delimited = render('```math\n$$\\sum_{i=1}^{n} i$$\n```\n\n```latex\n\\[\\int_0^1 x^2\\,dx\\]\n```');
  assert.equal((delimited.match(/class="katex-display"/g) || []).length, 2);
  assert.doesNotMatch(delimited, /katex-error/);
});

test('renders common standalone environments without double-wrapping existing math', () => {
  for (const formula of [
    '\\begin{equation}E=mc^2\\end{equation}',
    '\\begin{align}a&=b+c\\\\d&=e+f\\end{align}',
    '\\begin{cases}x^2 & x>0\\\\0 & x\\le 0\\end{cases}',
    '\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}',
  ]) {
    const html = render(formula);
    assert.match(html, /class="katex-display"/, formula);
    assert.doesNotMatch(html, /katex-error/, formula);
  }
  const wrapped = render('$$\n\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\n$$');
  assert.equal((wrapped.match(/class="katex-display"/g) || []).length, 1);
});

test('renders representative everyday math commands', () => {
  for (const formula of [
    '\\frac{a+b}{c}', '\\sqrt[n]{x}', 'x_i^2 + y_j^2',
    '\\sum_{i=1}^{n} i', '\\int_0^1 x\\,dx', '\\lim_{x\\to 0}\\frac{\\sin x}{x}',
    '\\alpha+\\beta\\leq\\pi', '\\vec{v}\\cdot\\hat{n}', '\\binom{n}{k}',
    '\\left(\\frac{a}{b}\\right)', '\\text{if }x>0',
  ]) {
    const html = render(`$${formula}$`);
    assert.match(html, /class="katex"/, formula);
    assert.doesNotMatch(html, /katex-error/, formula);
  }
});

test('preserves complete TeX documents and incomplete math fences as code', () => {
  for (const language of ['math', 'latex', 'tex']) {
    const document = render('```' + language + '\n\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n```');
    assert.match(document, /language-math-source/);
    assert.doesNotMatch(document, /class="katex"/);
  }
  const streaming = render('```math\n\\frac{a}{b}');
  assert.match(streaming, /language-math-source/);
  assert.doesNotMatch(streaming, /class="katex"/);
});

test('does not close a standalone environment with an example inside a code fence', () => {
  const html = render('\\begin{align}\n\n```text\n\\end{align}\n```');
  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /language-text/);
});

test('accepts backslash LaTeX delimiters', () => {
  const html = render('行内 \\(E=mc^2\\)\n\n\\[\\frac{a}{b}\\]');
  assert.equal((html.match(/class="katex"/g) || []).length, 2);
  assert.match(html, /class="katex-display"/);
});

test('does not enable trusted links in untrusted formulas', () => {
  const html = render('$\\href{javascript:alert(1)}{open}$');
  assert.doesNotMatch(html, /href="javascript:/i);
});
