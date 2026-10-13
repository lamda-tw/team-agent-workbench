"""Render reusable, code-checked interface walkthroughs into the HTML handbook.

Only the generated HTML is changed. Scenario copy lives in
docs/handbook/ui-scenarios.json so future handbook refreshes keep the diagrams.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import base64
import importlib.util
import os
import subprocess
from pathlib import Path

from handbook_revisions import record_and_embed
from handbook_paths import assert_portable_paths
from handbook_notes import render_notes
from handbook_screenshots import screenshot_caption, screenshot_search


ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "docs" / "handbook"
DATA = WEB / "ui-scenarios.json"
HTML = WEB / "index.html"
SCREENS = WEB / "ui-screens"


def escape(value: str) -> str:
    return html.escape(value, quote=True)


def screenshot_name(pane: dict, identifier: str, step_number: int, pane_number: int) -> str:
    """Keep image identity stable when a walkthrough combines or reorders steps."""
    name = pane.get('image', f'{identifier}-{step_number:02d}-{pane_number}.png')
    if not re.fullmatch(r'[a-z0-9-]+\.png', name):
        raise ValueError(f'Invalid screenshot filename: {name}')
    return name


def render_pane(pane: dict, identifier: str, step_number: int, pane_number: int) -> str:
    file = SCREENS / screenshot_name(pane, identifier, step_number, pane_number)
    if not file.exists():
        raise ValueError(f"Missing screenshot-style illustration: {file}")
    data = base64.b64encode(file.read_bytes()).decode("ascii")
    label = pane.get('heading') or f'{pane["actor"]}：{pane["screen"]}'
    alt = f'{pane["actor"]}打开{pane["screen"]}，当前状态：{pane["status"]}。'
    caption = screenshot_caption(file.name)
    return (
        '<div class="ui-person-pane ui-screen-shot">'
        f'<div class="ui-person-label">{escape(label)}</div>'
        f'<button class="zoom-image" type="button" aria-label="放大查看{escape(label)}">'
        f'<img src="data:image/png;base64,{data}" alt="{escape(alt)}" loading="lazy">'
        '<span>点击放大</span></button>' + caption + '</div>'
    )


def render_guide(spec: dict, identifier: str, actions: list[dict] | None = None, render_inline=escape) -> str:
    if actions is not None and len(actions) != len(spec["steps"]):
        raise ValueError(f"Written and illustrated step counts differ in {identifier}")
    steps = []
    for number, step in enumerate(spec["steps"], 1):
        panes = "".join(render_pane(pane, identifier, number, index) for index, pane in enumerate(step["panes"], 1))
        title = actions[number - 1]["label"] if actions is not None else step["title"]
        action_text = actions[number - 1]["detail"] if actions is not None else step.get("instruction", "")
        instruction = f'<p class="ui-scenario-instruction">{render_inline(action_text)}</p>' if action_text else ''
        substeps = (actions[number - 1] if actions is not None else step).get('actions', [])
        if substeps:
            instruction += '<ol class="ui-scenario-actions">' + ''.join(f'<li>{render_inline(item)}</li>' for item in substeps) + '</ol>'
        notes = actions[number - 1].get('notes', []) if actions is not None else step.get('notes', [])
        steps.append("".join([
            '<li class="ui-scenario-step">',
            '<div class="ui-scenario-step-head">',
            f'<span class="ui-scenario-number">{number:02d}</span>',
            f'<h3>{escape(title)}</h3></div>',
            instruction,
            render_notes(notes, render_inline),
            f'<div class="ui-screen-pair">{panes}</div>',
            f'<p class="ui-scenario-result">{render_inline(step["result"])}</p>' if step.get('result') else '',
            '</li>',
        ]))
    return (
        f'<figure class="ui-scenario-guide" data-scenario="{escape(identifier)}" aria-label="{escape(spec["caption"])}">'
        f'<ol class="ui-scenario-list">{"".join(steps)}</ol>'
        '</figure>'
    )


def search_text(spec: dict) -> str:
    return " ".join(
        [spec["caption"]] + [
            " ".join(
                [step["title"], step.get("instruction", ""), *step.get('actions', []), step.get("result", "")] + [
                    " ".join([pane["actor"], pane["screen"], pane["status"], pane["action"]]
                             + [text for row in pane["rows"] for text in row])
                    for pane in step["panes"]
                ]
            )
            for step in spec["steps"]
        ]
    )


def enhance_html(path: Path = HTML, summary: str | None = None, capture_ui: bool = True) -> None:
    if capture_ui:
        subprocess.run(["node", str(ROOT / "scripts" / "capture-handbook-app-ui.mjs")], cwd=ROOT, check=True)
    source = path.read_text(encoding="utf-8")
    source, css_count = re.subn(
        r"(<style>).*?(</style>)",
        lambda match: match.group(1) + (WEB / "handbook.css").read_text(encoding="utf-8") + match.group(2),
        source,
        count=1,
        flags=re.S,
    )
    if css_count != 1:
        raise ValueError("Handbook inline style not found")
    match = re.search(r'(<script type="application/json" id="manual-data">)(.*?)(</script>)', source, re.S)
    if not match:
        raise ValueError("Handbook article data not found")
    articles = json.loads(match.group(2))
    scenarios = json.loads(DATA.read_text(encoding="utf-8"))
    structure = json.loads((WEB / "structure.json").read_text(encoding="utf-8"))
    contexts = {case['id']: (case['id'], case) for case in structure['use_cases']}
    contexts.update({supplement['id']: (case['id'], supplement) for case in structure['use_cases'] for supplement in case.get('supplements', [])})
    expected = {"example", *contexts}
    if set(scenarios) != expected:
        raise ValueError(f"Use-case guides differ from structure: {set(scenarios) ^ expected}")
    spec = importlib.util.spec_from_file_location("build_handbook", ROOT / "scripts" / "build-handbook.py")
    if spec is None or spec.loader is None:
        raise ValueError("Could not load handbook article renderer")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    titles = {article["id"]: article["title"] for article in articles}
    titles.update({heading["id"]: heading["title"] for article in articles for heading in article["headings"]})
    builder.DESTINATION_TITLES.update(titles)
    case_ids = {case["id"] for case in structure["use_cases"]}
    cases = {case["id"]: case for case in structure["use_cases"]}
    articles = [article for article in articles if article["id"] not in case_ids]
    articles.extend(builder.use_case_page(case) for case in structure["use_cases"])
    changed = set()
    by_id = {article['id']: article for article in articles}
    for identifier, spec in scenarios.items():
        page_id, context = contexts.get(identifier, (identifier, None))
        article = by_id[page_id]
        if spec.get('page', identifier) != page_id:
            raise ValueError(f'Scenario owner differs from handbook structure: {identifier}')
        if not spec["steps"] or any(not 1 <= len(step["panes"]) <= 3 for step in spec["steps"]):
            raise ValueError(f"Every {identifier} step needs one to three distinct interface panels")
        old = article["html"]
        pattern = (r'<figure class="case-diagram" data-scenario="' + re.escape(identifier) + r'".*?</figure><ol class="case-steps">.*?</ol>'
                   if context is not None else r'<figure class="(?:case-diagram|ui-scenario-guide)".*?</figure>')
        updated, count = re.subn(pattern, lambda _: render_guide(spec, identifier, context['steps'] if context is not None else None, builder.scenario_inline), old, count=1, flags=re.S)
        if count != 1:
            raise ValueError(f"Missing old diagram in {identifier}")
        article["html"] = updated
        search_by_scenario = article.setdefault('uiScenarioSearchTexts', {})
        previous = search_by_scenario.get(identifier, article.pop('uiScenarioSearchText', '') if identifier == page_id else '')
        if previous:
            article["text"] = article["text"].replace(previous, "").rstrip()
        current = search_text(spec) + ' ' + ' '.join(screenshot_search(screenshot_name(pane, identifier, i, j)) for i, step in enumerate(spec['steps'], 1) for j, pane in enumerate(step['panes'], 1))
        article["text"] += " " + current
        search_by_scenario[identifier] = current
        target = "example-walkthrough" if identifier == "example" else identifier + "-steps" if identifier == page_id else identifier
        for section in article["sections"]:
            if section["id"] == target:
                if previous:
                    section["text"] = section["text"].replace(previous, "").rstrip()
                section["text"] += " " + current
                break
        else:
            raise ValueError(f"Missing walkthrough section in {identifier}")
        changed.add(identifier)
    if changed != set(scenarios):
        raise ValueError(f"Missing scenario articles: {set(scenarios) - changed}")
    order = [page for group in structure["groups"] for page in group["pages"]]
    if set(order) != {article["id"] for article in articles} or len(order) != len(articles):
        raise ValueError("Handbook navigation and articles differ")
    by_id = {article["id"]: article for article in articles}
    articles = [by_id[identifier] for identifier in order]
    assert_portable_paths(articles)
    data = json.dumps(articles, ensure_ascii=False).replace("</", r"<\/")
    source = source[:match.start(2)] + data + source[match.end(2):]
    nav = re.search(r'(<script type="application/json" id="manual-structure">)(.*?)(</script>)', source, re.S)
    if not nav:
        raise ValueError("Handbook navigation data not found")
    navigation = json.dumps({"groups": structure["groups"], "search_defaults": structure["home"]["search_defaults"]}, ensure_ascii=False).replace("</", r"<\/")
    source = source[:nav.start(2)] + navigation + source[nav.end(2):]
    source = record_and_embed(source, summary or os.environ.get("HANDBOOK_CHANGE_SUMMARY", "更新 HTML 手册"))
    path.write_text(source, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", default=None, help="本次文档修改说明；同一内容重复构建不会新增记录")
    parser.add_argument("--reuse-screens", action="store_true", help="Reuse reviewed screenshots for text and layout edits.")
    args = parser.parse_args()
    enhance_html(summary=args.summary, capture_ui=not args.reuse_screens)
    print(f"Updated interface walkthroughs in {HTML}")
