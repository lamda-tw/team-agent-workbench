// Verify the self-contained HTML walkthroughs after refreshing their screenshots.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const html = path.join(root, 'docs/handbook/index.html');
const scenarios = JSON.parse(await fs.readFile(path.join(root, 'docs/handbook/ui-scenarios.json'), 'utf8'));
const screenshotManifest = JSON.parse(await fs.readFile(path.join(root, 'docs/handbook/ui-screens/manifest.json'), 'utf8'));
const guides = JSON.parse(await fs.readFile(path.join(root, 'docs/handbook/screenshot-guides.json'), 'utf8'));
assert.equal(screenshotManifest.renderer, 'production-react', 'Interface images must come from the actual app renderers');
assert.deepEqual(Object.keys(guides).sort(), screenshotManifest.captures.map(capture => capture.file).sort(), 'Every screenshot needs a guide');
for (const capture of screenshotManifest.captures) {
  const guide = guides[capture.file];
  assert.equal(capture.annotation?.kind, guide.kind, `${capture.file} needs its current annotations`);
  if (guide.kind === 'display') assert(guide.explanation, `${capture.file} needs a display explanation`);
  else {
    assert(guide.callouts.length > 0, `${capture.file} needs callouts`);
    assert.deepEqual(capture.annotation.callouts.map(item => item.text), guide.callouts.map(item => item.text), `${capture.file} caption differs from its callouts`);
    for (const item of capture.annotation.callouts) {
      for (const box of [item.box, item.badge]) {
        const viewport = capture.viewport || screenshotManifest.viewport;
        assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${capture.file} has a clipped annotation`);
      }
    }
  }
}
for (const [id, scenario] of Object.entries(scenarios)) {
  for (const [i, step] of scenario.steps.entries()) for (const [j, pane] of step.panes.entries()) {
    const file = pane.image || `${id}-${String(i + 1).padStart(2, '0')}-${j + 1}.png`;
    const capture = screenshotManifest.captures.find(item => item.file === file);
    assert.equal(capture?.entry, pane.actor.includes('总管理员') ? 'start-admin-dev.cmd' : 'start-user-dev.cmd', `${file} uses the wrong app entry`);
  }
}
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.context().setOffline(true);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(html).href);
  const data = await page.evaluate(() => {
    const articles = JSON.parse(document.getElementById('manual-data').textContent);
    const navigation = JSON.parse(document.getElementById('manual-structure').textContent);
    return { articles, navigation };
  });
  const ids = data.articles.map(article => article.id);
  const captionFiles = data.articles.flatMap(article => [...article.html.matchAll(/data-screenshot="([^"]+)"/g)].map(match => match[1]));
  assert.deepEqual(captionFiles.sort(), Object.keys(guides).sort(), 'Screenshot captions must cover every image exactly once');
  for (const article of data.articles) {
    const names = [...article.html.matchAll(/data-screenshot="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(names).size, names.length, `${article.id} repeats a screenshot`);
  }
  let totalScenarioImages = 0;
  const revisions = JSON.parse(await fs.readFile(path.join(root, 'docs/handbook/revisions.json'), 'utf8')).revisions;
  assert(revisions.length >= 1, 'Missing handbook revision history');
  assert.equal(await page.locator('.revision-stamp').count(), 1, 'Missing visible Git baseline');
  assert.match(await page.locator('.revision-stamp').textContent(), new RegExp(revisions.at(-1).base_commit.slice(0, 7)));
  await page.locator('.revision-history summary').click();
  assert.equal(await page.locator('.revision-history li').count(), revisions.length, 'Revision list count');
  assert((await page.locator('.revision-history').textContent()).includes(revisions.at(-1).base_commit), 'Full Git commit ID missing');
  const ordered = data.navigation.groups.flatMap(group => group.pages);
  assert.deepEqual(ids, ordered, 'Sidebar order differs from article order');
  const targets = new Set(data.articles.flatMap(article => [article.id, ...article.headings.map(heading => heading.id)]));
  for (const article of data.articles) {
    for (const link of article.html.matchAll(/href="#([^"]+)"/g)) {
      assert(targets.has(link[1]), `${article.id} has a broken link to ${link[1]}`);
    }
  }
  const bannedGuideCopy = ['截图式界面示意', '按当前工作台布局与按钮绘制', '任务名称和内容为说明样例', '每一步在谁的界面出现'];
  for (const phrase of bannedGuideCopy) {
    assert(!data.articles.some(article => article.html.includes(phrase)), `Editorial note leaked into guide: ${phrase}`);
  }
  for (const id of ['case-team-setup', 'case-first-session', 'case-admin-results', 'case-personal-results', 'case-session-routes']) {
    const article = data.articles.find(item => item.id === id);
    assert(article.html.indexOf('参与者与前提') < article.html.indexOf('ui-scenario-guide'), `${id} shows screenshots before context`);
    assert(!article.html.includes('对应说明') && !article.headings.some(heading => heading.id === id + '-links'), `${id} still contains the removed reference section`);
    assert(!article.html.includes('class="case-steps"'), `${id} repeats the written steps after the walkthrough`);
  }
  const collaboration = data.articles.find(item => item.id === 'example');
  assert.equal(collaboration.title, '团队协作', 'Collaboration example title');
  assert(!collaboration.html.includes('派发任务'), 'Collaboration example starts from task assignment');
  assert(!ids.includes('case-egress-mixed'), 'Management access must be a section of the session tutorial');
  const sessionTutorial = data.articles.find(item => item.id === 'case-session-routes');
  assert(sessionTutorial.headings.some(heading => heading.id === 'case-egress-mixed' && heading.title === '网络权限不足时接入管理端'), 'Missing embedded network access section');
  assert.equal(await page.locator('#navigation a[data-page="case-egress-mixed"]').count(), 0, 'Duplicate access tutorial in sidebar');
  for (const [id, spec] of Object.entries(scenarios)) {
    await page.goto(pathToFileURL(html).href + '#' + id);
    const pageId = spec.page || id;
    const article = data.articles.find(item => item.id === pageId);
    assert(article, `Missing ${id} article`);
    await page.waitForFunction(title => document.querySelector('article h1')?.textContent === title, article.title);
    const walkthrough = page.locator(`.ui-scenario-guide[data-scenario="${id}"]`);
    assert.equal(await walkthrough.count(), 1, `${id} walkthrough`);
    assert.equal(await walkthrough.locator('.ui-scenario-step').count(), spec.steps.length, `${id} step count`);
    const paneCount = spec.steps.reduce((count, step) => count + step.panes.length, 0);
    assert.equal(await walkthrough.locator('.ui-person-pane.ui-screen-shot').count(), paneCount, `${id} panel count`);
    assert.equal(await walkthrough.locator('.ui-person-pane .screenshot-caption').count(), paneCount, `${id} screenshots need annotation metadata`);
    for (const step of spec.steps) for (const pane of step.panes) {
      const guide = guides[pane.image];
      if (guide?.kind !== 'instruction') continue;
      const visible = guide.callouts.filter(item => item.show_caption !== false);
      const caption = page.locator(`.screenshot-caption[data-screenshot="${pane.image}"]`);
      assert.equal(await caption.locator('li').count(), visible.length, `${pane.image} repeats an intentionally hidden explanation`);
      assert.equal(await caption.locator(':scope > strong').count(), 0, `${pane.image} repeats the image heading`);
    }
    totalScenarioImages += paneCount;
    const scenarioImages = walkthrough.locator('.ui-person-pane.ui-screen-shot img');
    for (let i = 0; i < await scenarioImages.count(); i++) {
      await scenarioImages.nth(i).scrollIntoViewIfNeeded();
      await scenarioImages.nth(i).evaluate(image => image.decode());
      assert(await scenarioImages.nth(i).evaluate(image => image.complete && image.naturalWidth > 0), `${id} image ${i + 1} did not load`);
    }
    assert.equal(await page.locator(`#navigation a[data-page="${pageId}"]`).count(), 1, `${id} sidebar link`);
  }
  await page.goto(pathToFileURL(html).href + '#case-first-session');
  await page.waitForFunction(() => document.querySelector('article h1')?.textContent === '建立工作组并完成首次协作');
  const firstSessionText = await page.locator('article').innerText();
  for (const phrase of ['线下约定', '线下协作路径', '入口 A', '入口 B', '两条路径', '如果已经']) {
    assert(!firstSessionText.includes(phrase), `First-session guide contains branch-writing phrase: ${phrase}`);
  }
  const images = page.locator('.ui-person-pane.ui-screen-shot img');
  for (let i = 0; i < await images.count(); i++) {
    await images.nth(i).scrollIntoViewIfNeeded();
    assert(await images.nth(i).evaluate(image => image.complete && image.naturalWidth > 0), `New scenario image ${i + 1} did not load`);
  }
  await page.locator('.zoom-image').first().click();
  assert(await page.getByRole('dialog', { name: '放大查看配图' }).isVisible(), 'Image zoom did not open');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const id of Object.keys(scenarios)) {
    const article = data.articles.find(item => item.id === (scenarios[id].page || id));
    await page.goto(pathToFileURL(html).href + '#' + id);
    await page.waitForFunction(title => document.querySelector('article h1')?.textContent === title, article.title);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${id} mobile viewport overflows`);
  }
  assert.deepEqual(errors, [], 'Browser script errors');
  console.log(JSON.stringify({ passed: true, articles: ids.length, scenarios: Object.keys(scenarios).length, scenarioImages: totalScenarioImages, offline: true }));
} finally {
  await browser.close();
}
