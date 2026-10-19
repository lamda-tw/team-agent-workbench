"""Check self-contained handbook navigation and offline package without a browser."""
from html.parser import HTMLParser
from pathlib import Path
from zipfile import ZipFile
import argparse
import json
import re
from urllib.parse import unquote
from manual_meta import read_meta

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / 'docs/handbook/index.html'
META = read_meta()
PACKAGE = ROOT / 'docs/manuals' / f'{META.filename}.zip'
STRUCTURE = json.loads((ROOT / 'docs/handbook/structure.json').read_text(encoding='utf-8'))
SCENARIOS = next(group['pages'] for group in STRUCTURE['groups'] if group['title'] == '操作教程')
SCENARIO_GUIDES = json.loads((ROOT / 'docs/handbook/ui-scenarios.json').read_text(encoding='utf-8'))


class Collect(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids, self.links, self.images, self.scripts = set(), [], [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            self.ids.add(attrs['id'])
        if tag == 'a' and 'href' in attrs:
            self.links.append(attrs['href'])
        if tag == 'img':
            self.images.append(attrs.get('src', ''))
        if tag == 'script' and 'src' in attrs:
            self.scripts.append(attrs['src'])


def check(html, names, prefix):
    match = re.search(r'<script type="application/json" id="manual-data">(.*?)</script>', html, re.S)
    assert match, 'Missing embedded handbook data'
    articles = json.loads(match[1])
    structure_match = re.search(r'<script type="application/json" id="manual-structure">(.*?)</script>', html, re.S)
    if structure_match:
        structure = json.loads(structure_match[1])
        ordered_ids = [page for group in structure['groups'] for page in group['pages']]
        assert ordered_ids == [article['id'] for article in articles], 'Sidebar and article order differ'
        assert len(ordered_ids) == len(set(ordered_ids)), 'Page belongs to multiple groups'
        for group in structure['groups']:
            for page_id in group['pages']:
                assert next(article for article in articles if article['id'] == page_id)['group'] == group['title']
        cases = next(group for group in structure['groups'] if group['title'] == '操作教程')
        assert cases['pages'] == SCENARIOS
    else:
        assert len(articles) == 31, 'Legacy package topic count changed'
    all_ids = [article['id'] for article in articles]
    all_ids += [heading['id'] for article in articles for heading in article['headings']]
    if not structure_match:
        all_ids += ['quickstart-member', 'quickstart-lead', 'quickstart-admin',
                    'common-actions', 'complete-task-index']
    assert len(all_ids) == len(set(all_ids)), 'Duplicate destination ID'
    ids = set(all_ids)
    page = Collect()
    page.feed(html[:match.start()] + html[match.end():])
    assert not page.scripts, 'External runtime script'
    ids.update(page.ids)
    links, images = list(page.links), list(page.images)
    for article in articles:
        part = Collect()
        part.feed(article['html'])
        ids.update(part.ids)
        links.extend(part.links)
        images.extend(part.images)
    anchors = [unquote(link[1:]) for link in links if link.startswith('#')]
    missing = sorted(set(anchors) - ids)
    assert not missing, f'Broken navigation: {missing}'
    assert all(image.startswith('data:image/png;base64,') or image == '' for image in images), [
        image[:100] for image in images if image and not image.startswith('data:image/png;base64,')]
    inline_images = [image for image in images if image]
    assert len(inline_images) >= 8 and any(a['id'] == 'tasks' and '<figure>' in a['html'] for a in articles)
    if structure_match:
        for case_id in SCENARIOS:
            case = next(article for article in articles if article['id'] == case_id)
            assert '<figure class="ui-scenario-guide"' in case['html'], f'Missing interface guide in {case_id}'
            expected_images = sum(len(step['panes']) for identifier, guide in SCENARIO_GUIDES.items() if guide.get('page', identifier) == case_id for step in guide['steps'])
            assert case['html'].count('class="ui-person-pane ui-screen-shot"') == expected_images, f'Incomplete interface steps in {case_id}'
        egress = next(article for article in articles if article['id'] == 'egress-reference')
        assert '<li>选择管理端访问外网的方式：<ul>' in egress['html']
        assert re.search(r'</ul></li><li>(?:点击 <strong>保存并应用</strong>|在 <strong>成员可通过出口访问</strong>)', egress['html'])
        acceptance = next(article for article in articles if article['id'] == 'acceptance-reference')
        assert 'href="#deployment-topic-9"' in acceptance['html']
    for link in links:
        if link.startswith(('#', 'https://', 'http://', 'mailto:')):
            continue
        assert unquote(link.split('#')[0]).removeprefix(prefix) in names, f'Missing offline link: {link}'
    baseline = (json.loads((ROOT / 'docs/handbook/revisions.json').read_text(encoding='utf-8'))['revisions'][-1]['base_commit']
                if structure_match else META.commit)
    assert '9552017' not in html and baseline in html
    return {'topics': len(articles), 'sections': sum(len(a['sections']) for a in articles),
            'navigation_targets': len(ids), 'internal_links': len(anchors), 'inline_images': len(inline_images)}


def main(html_only=False):
    source = HTML.read_text(encoding='utf-8')
    local_names = {p.relative_to(ROOT / 'docs').as_posix() for p in (ROOT / 'docs').rglob('*') if p.is_file()}
    result = {'html': check(source, local_names, '../')}
    if not html_only:
        with ZipFile(PACKAGE) as archive:
            assert archive.testzip() is None
            names = set(archive.namelist())
            assert {'使用手册.html', f'{META.filename}.docx',
                    f'{META.filename}.pdf', 'Markdown/user-guide.md',
                    'Markdown/result-classification.md', 'Markdown/background-testing.md'} <= names
            result['package'] = check(archive.read('使用手册.html').decode('utf-8'), names, '')
            result['package_files'] = len(names)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--html-only', action='store_true', help='Verify the current HTML without an older offline ZIP package.')
    main(html_only=parser.parse_args().html_only)
