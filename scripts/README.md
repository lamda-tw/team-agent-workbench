# 开发与维护脚本

应用只从仓库根目录的 `start-user-dev.cmd`、`start-admin-dev.cmd` 启动。这里的脚本由启动器、npm 命令或维护流程使用，执行命令前请进入仓库根目录。

| 用途 | 文件 | 执行方式 |
| --- | --- | --- |
| 内部启动流程 | `start-dev-hidden.ps1`、`startup-process.ps1`、`launch-desktop.mjs` | 两个根目录入口自动调用，无需单独运行 |
| 依赖与 Electron 缓存 | `startup-dependencies.mjs`、`electron-runtime-cache.mjs` | 启动器按需调用 |
| 编译应用 | `build.mjs`、`build-assets.mjs` | `npm run build`；仅验证用 `npm run build:check` |
| 准备 CLI 与打包 | `prepare-runtimes.ps1`、`package.mjs`、`release-paths.mjs` | 按[部署指导](../docs/deployment-guide.md)准备依赖，再执行 `npm run package` |
| 安装产物验证 | `check-packaged.mjs`、`verify-release.mjs` | 有对应版本的安装产物后执行；不要用旧包验证新源码 |
| 后台测试 | `test-background.mjs`、`background-guard.cjs` | `npm test`；单项可传 `tests/名称.test.ts` |
| 界面验证 | 各 `*-smoke.mjs`、`*-smoke.ts` 及其辅助模块 | 优先使用 `package.json` 对应的 `test:*` 命令 |
| Windows CLI 路径验证 | `check-windows-provider-paths.ts` | `npm run test:provider-paths`，使用模拟账号，覆盖中文、空格与 CMD 路径 |
| 真实 CLI 协议检查 | `check-providers.ts` | `npx tsx scripts/check-providers.ts`，仅初始化握手，不发送模型任务 |
| 手册生成与校验 | `refresh-handbook.py`、`build-*manual*.py`、`build-handbook.py`、`handbook_*.py`、`verify-*.py` | 见[手册维护说明](../docs/manual-maintenance.md) |
| 手册界面配图 | `capture-handbook-app-ui.mjs` 及辅助模块 | 手册生成流程直接调用；读取当前 React 界面，不需要另一层启动包装 |
| 手册链接与步骤验证 | `verify-handbook-labels.py`、`verify-handbook-ui-scenarios.mjs` | `npm run test:handbook-labels`、`npm run test:handbook-ui` |
| 真实算法比赛演练 | `competition-pilot.ts`、`pilot-evidence.ts` | `npm run test:competition -- --input <材料目录> --output <输出目录> --python <Python程序>`；使用个人模型账号和额度，需主动执行 |

后台测试与界面测试分开运行。界面验证使用独立的测试数据；脚本中的模拟账号不用于正式部署。诊断输出和测试产物位于 `.test-data/` 或 `artifacts/`，不应上传个人登录数据。

Codex 桌面联动的用户入口在应用内部。`codex-workflow-smoke.ts` 验证普通工作流，`codex-desktop-beta-smoke.ts` 验证共享后台传输，`codex-desktop-sync-smoke.ts` 保留独立后台与共享后台的对照测试；三者均使用本机模型替身。`prepare-codex-desktop-beta-demo.ts` 只给自动测试准备数据，不再作为用户启动器。

清理脚本时，先检查 npm、脚本导入、Python 调用和文档引用；缺少 npm 命令并不代表脚本无用。删除旧功能测试后同步移除旧执行说明，保留验证当前行为的用例。
