# 使用手册维护说明

## 唯一源稿与生成物

`docs/user-guide.md` 是使用手册的正文源稿。首页的文档版本、适用软件版本、功能核对版本和发布日期由 `scripts/manual_meta.py` 读取，生成脚本从这里取得文件名、页脚版本、网页版本标记与代码仓链接。这个脚本也列明网页版参考主题和离线包 Markdown 文件。升级版本时只改源稿首页；增删参考主题时只改这一处清单，不要手工改 HTML、Word 或 PDF。

可维护的配图在 `docs/images/user-manual/`。其中 5 张流程示意图由 `scripts/build-manual-diagrams.py` 绘制；3 张管理员界面图来自隔离演示环境，不含真实团队或模型数据。网页的版式源文件是 `docs/handbook/template.html`、`handbook.css` 和 `handbook.js`。

生成物包括 `docs/handbook/index.html`，以及 `docs/manuals/团队工作台使用手册_v<版本>.docx`、同名 PDF 和 ZIP。网页可以单独离线打开；ZIP 包含互相可打开的网页、Word、PDF、Markdown 与配图。Word/PDF 的配套资料链接指向源稿所标注代码版本的仓库，需要联网。

部署操作维护在 `docs/deployment-guide.md`，网络出口维护在 `docs/network-egress.md`。它们作为网页独立主题和离线包 Markdown 收录，不复制成长篇手册正文。安装包无需因为手册刷新而重建。

## 日常刷新

1. 先更新 Markdown 正文和必要的图。保留已发布的显式锚点；新增章节时检查 `scripts/build-handbook.py` 中的主题分组。按钮名称、角色权限和状态须与当前代码一致。表格适合字段、角色、状态等对照；复杂操作用短段落和步骤解释。
2. 运行 `python scripts/refresh-handbook.py`。它依次处理示意图、HTML、Word、PDF、ZIP，然后核验正文与链接。脚本把输入和输出摘要保存在 `.test-data/manual/build-state.json`；未变化的环节会显示 `SKIP`，无需重复生成。需要全量重建时加 `--force`。删除状态文件也会全量重建。
3. 运行 `python scripts/qa-manual-layout.py`，用 Poppler 渲染 PDF 的每一页，并在 `.test-data/manual/layout/` 生成分组预览图。检查图片、表格、段落分页、页码和导航。界面或响应式排版有改动时，在独立测试机器或维护时段运行 `node scripts/handbook-smoke.mjs`；不要在有人使用桌面时启动浏览器自动化。
4. 检查刷新流程中的 `scripts/verify-user-manual.py`、`scripts/verify-handbook-static.py` 与 `scripts/verify-handbook-labels.py` 输出，分别核对文档正文与书签、离线包与相对路径，以及链接文字与跳转标题。链接文字也可单独执行 `npm run test:handbook-labels`。界面步骤改动后执行 `npm run test:handbook-ui`，检查截图、实际步骤、离线阅读和窄屏布局。校验记录写入 `.test-data/manual/verification-v<版本>.json`。
5. 提交源稿、配图、网页源文件、生成物和可复用脚本。`.test-data` 是本机缓存和验证记录，不纳入发布包。

刷新脚本需要 Pillow、python-docx、lxml、pypdf，以及用于 PDF 导出的 Microsoft Word。`scripts/export-manual-pdf.ps1` 使用隐藏 Word 实例从同一 DOCX 导出 PDF；无需另写 PDF 正文。所有生成脚本均不调用模型、网络或团队服务器。Windows 环境如使用项目配置的 Python 运行时，直接把上面的 `python` 替换为该运行时路径。

封面后的 `<!-- pagebreak -->` 让 Word/PDF 从新页开始任务导航；其余章节自然分页，避免只剩一两段的空疏页面。`<a id="section-6-3"></a>` 这类锚点供 Markdown、网页和 Word/PDF 共用；Word 默认可能需要 Ctrl+单击打开链接。ZIP 应先完整解压，再双击 `使用手册.html`。单独打开 HTML 仍可阅读正文与配图，但“其他格式”需要同目录结构中的配套文件。

## 排版和内容原则

正文先回答“我什么时候需要做这件事”，再写入口、步骤、完成标志和常见异常。重要权限放在操作旁边。示意图解释正式部署角色、资料带入、成果上传、账号同步范围和任务验收路径；图是逻辑示意，界面图才代表实际按钮布局。复杂表格在网页窄屏可以横向滚动，Word/PDF 用较浅的表头、细网格和舒适的单元格留白。

本版保留 16 个正文章节。每次刷新后的实际页数、文本核对量和链接数量以验证 JSON 为准，避免在维护说明中抄写易过期的统计值。当前桌面处于活跃使用状态时，只运行后台静态验证；此前界面验收记录保存在 `.test-data/handbook-ui/` 和 `.test-data/handbook-package-ui/`，不能替代本版的浏览器验收。

## 外部文档参考

- [GitHub Docs](https://docs.github.com/en/get-started)：参考按任务组织、搜索和主题导航。
- [Nextcloud User Manual](https://docs.nextcloud.com/server/stable/user_manual/en/)：参考登录、文件和协作主题的组织方式。
- [VS Code User Interface](https://code.visualstudio.com/docs/editing/getting-started/userinterface)：参考本页目录和界面区域说明方式。

这些是外部网页手册参考，未选用第三方 Word/PDF 模板。具体操作按本项目代码编写，没有复制第三方截图或大段正文。
