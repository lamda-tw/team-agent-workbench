"""Incrementally rebuild the manual from Markdown and reusable assets.

Requires Pillow, python-docx, lxml, pypdf, and Microsoft Word for PDF export.
The state file is a disposable cache; deleting it simply rebuilds all outputs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

from manual_meta import PACKAGE_MARKDOWN, read_meta

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
SCRIPTS = ROOT / 'scripts'
META = read_meta()
STATE_PATH = ROOT / '.test-data/manual/build-state.json'
IMAGES = DOCS / 'images/user-manual'
DIAGRAMS = [IMAGES / name for name in (
    'reference-flow.png', 'publish-flow.png', 'sync-scope.png',
    'task-lifecycle.png', 'deployment-logic.png')]
HTML = DOCS / 'handbook/index.html'
DOCX = DOCS / 'manuals' / f'{META.filename}.docx'
PDF = DOCX.with_suffix('.pdf')
PACKAGE = DOCX.with_suffix('.zip')


def digest(paths: list[Path]) -> str:
    value = hashlib.sha256()
    for path in sorted(set(paths)):
        value.update(path.relative_to(ROOT).as_posix().encode())
        if not path.exists():
            value.update(b'<missing>')
        else:
            value.update(path.read_bytes())
    return value.hexdigest()


def run(*args: str) -> None:
    print('+', ' '.join(args), flush=True)
    subprocess.run(args, cwd=ROOT, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--force', action='store_true', help='rebuild all artifacts')
    args = parser.parse_args()
    state = json.loads(STATE_PATH.read_text(encoding='utf-8')) if STATE_PATH.exists() else {}
    steps: dict[str, dict] = state.get('steps', {}) if state.get('schema') == 1 else {}

    def stage(name: str, inputs: list[Path], outputs: list[Path], command: list[str]) -> None:
        input_hash = digest(inputs)
        previous = steps.get(name, {})
        output_hash = digest(outputs)
        current = (previous.get('input') == input_hash and
                   previous.get('output') == output_hash and all(p.exists() for p in outputs))
        if current and not args.force:
            print(f'SKIP {name}: inputs and outputs unchanged', flush=True)
            return
        run(*command)
        missing = [str(p) for p in outputs if not p.exists()]
        if missing:
            raise RuntimeError(f'{name} did not create: {missing}')
        steps[name] = {'input': input_hash, 'output': digest(outputs)}
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps({'schema': 1, 'steps': steps}, indent=2), encoding='utf-8')

    python = sys.executable
    metadata = SCRIPTS / 'manual_meta.py'
    source = DOCS / 'user-guide.md'
    images = sorted(IMAGES.glob('*.png'))
    documents = [DOCS / name for name in PACKAGE_MARKDOWN]

    stage('diagrams', [SCRIPTS / 'build-manual-diagrams.py'], DIAGRAMS,
          [python, str(SCRIPTS / 'build-manual-diagrams.py')])
    images = sorted(IMAGES.glob('*.png'))
    stage('html', documents + images + [metadata, SCRIPTS / 'build-handbook.py',
          DOCS / 'handbook/template.html', DOCS / 'handbook/handbook.css',
          DOCS / 'handbook/handbook.js', DOCS / 'handbook/structure.json'], [HTML],
          [python, str(SCRIPTS / 'build-handbook.py')])
    stage('word', [source, metadata, SCRIPTS / 'build-user-manual.py'] + images,
          [DOCX], [python, str(SCRIPTS / 'build-user-manual.py')])
    stage('pdf', [DOCX, SCRIPTS / 'export-manual-pdf.ps1'], [PDF],
          ['powershell', '-NoProfile', '-NonInteractive', '-File',
           str(SCRIPTS / 'export-manual-pdf.ps1'), '-Docx', str(DOCX), '-Pdf', str(PDF)])
    stage('package', documents + images + [metadata, HTML, DOCX, PDF,
          SCRIPTS / 'package-handbook.py'], [PACKAGE],
          [python, str(SCRIPTS / 'package-handbook.py')])
    run(python, str(SCRIPTS / 'verify-user-manual.py'))
    run(python, str(SCRIPTS / 'verify-handbook-static.py'))
    run(python, str(SCRIPTS / 'verify-handbook-labels.py'))
    print('Manual refresh complete.', flush=True)


if __name__ == '__main__':
    main()
