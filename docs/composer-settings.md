# 会话输入框与显示空间

以下通用设置针对 CLI 会话。**Cursor 原生联动 Beta** 使用另一条原生控制链路：模型、模式和权限直接读取并修改关联的 IDE 会话，原生确认后才显示为生效；不使用 CLI 的选项或配置。Skill、MCP、规则、参考资料和模型详细参数统一在 Cursor 中管理。详见 [Cursor 原生联动](cursor-desktop-sync.md#模型模式与权限)。

- Codex 与 Cursor 的模式、模型和执行权限放在输入框底部；文件引用、Skill 和 MCP 状态查看收入“＋”菜单。Codex 支持 `$名称` 引用 Skill、`@名称` 引用插件；Cursor 支持 `/技能名` 调用、`@名称` 选择 Skill。输入 `/` 可搜索命令和已启用 Skills。Claude Code 保留自己的能力菜单。
- 模式切换使用原生协议：Codex 查询 `collaborationMode/list`，每轮传入 `turn/start.collaborationMode` 并使用内置模式指令；Cursor 查询 ACP 的可用模式，使用 `session/set_mode`。未支持的模式不会通过提示词伪造。输入框支持 Shift+Tab，Codex `/plan` 开关 Plan，Cursor `/plan`、`/agent`、`/ask` 切换对应模式。
- 模式与执行权限独立。原生计划正文及进度直接展示；Codex 计划完成后可修改或执行，在原会话中重新制定计划或切回 Agent。Cursor 计划确认可执行、提交修订或取消；执行前原生切换 Agent，修订作为 `cursor/create_plan` 的拒绝理由回传，等待新计划。旧计划、未完成计划和已执行计划不能重复执行。
- 工具管理与对话分离：设置 → 本机与 CLI，或会话“更多”菜单打开 **Codex 设置／Cursor 自定义**，浏览 MCP、Skills、插件；`/mcp` 只显示状态与工具，可跳转设置。设置支持 Esc、关闭与键盘焦点限制，不消耗输入草稿。
- 空闲时选择即应用；正在执行或等待授权时，当前回复和待授权操作继续按原设置运行，新设置从下一轮生效。修改不发起推理、不重发任务、不创建新会话。
- Codex 使用原 thread/resume + turn/start 的 model；Cursor 使用原 session/load + session/set_model；Claude Code 使用 `--resume` 与 `--model`。保留 nativeId、历史引用记录及未发送草稿。选择具名模型（包括列表中标为默认的具体模型），避免将空 model 错当成原生会话的模型重置。
- 模型菜单显示账号额度、官方额度页和刷新入口。Cursor 沿用现有额度查询能力；不可读取时明确显示不可用。Cursor ACP 不支持的 Auto-review 仍禁用，Allowlist 配置仍需明确操作。
- 保存或应用设置期间服务端拒绝同会话的并发发送和设置变更；不会在进程关闭期间以旧模型启动任务。正在提交消息时不允许修改；单纯读取 Cursor 命令目录触发的启动会等待完成后切换模式。
- 顶栏缩至 52px，会话工具栏约 58px。项目说明和阶段摘要位于工具栏“AI 参考内容”，资料新版本保留更新标记。聊天区独立滚动，参考菜单不挤压高度。
- Skill 与插件选择只作用于下一条消息，并作为未发送输入按会话保存。发送成功后清空；发送失败、切换会话或重启工作台时保留。已发送消息显示当轮使用的能力标签，轨迹也保留这些选择。
- Codex 从当前原生会话调用 `skills/list` 和 `plugin/installed`；发送时分别使用 `$skill`、`@plugin`，并附结构化 `skill` 或 `mention(plugin://...)` 输入。插件安装、登录、启停继续由 Codex 管理。
- Codex MCP 使用原生配置和状态接口。个人配置支持添加、编辑、删除、启停与 OAuth 登录；编辑、删除使用原生版本校验，保留其他服务器及认证字段。项目、插件或管理员来源只读。配置同步到独立运行目录，并重载本窗口已打开的 Codex runtime，当前回复继续；其他窗口在刷新后读取新配置。
- Cursor MCP 单独读取个人和项目 `.cursor/mcp.json`，项目同名配置优先；个人配置可添加、编辑、删除，启停及登录调用原生 CLI。保存使用独占文件锁和原子替换，保留其他配置。ACP 没有连接状态及热重载接口时，显示“已配置 · 由 Cursor 连接”，下一轮重新加载，当前回复继续。MCP 不再伪装成插件，不再给消息追加工具提示。
- MCP 凭据由提供方 CLI 管理，会话快照和轨迹不记录授权地址、Token、环境变量值或 HTTP 请求头。Codex 个人 Skill 可原生启停；Cursor Skills 来自 ACP 命令目录。插件库展示 Codex 原生已安装插件及 Cursor 本地插件，并提供个人目录和官方安装入口；Cursor 市场插件的完整管理仍在 Cursor 中进行。
- Claude Code 从个人和项目 `.claude/skills`、`.claude/commands` 发现可用命令，按 `/name` 调用；`claude plugin list --json` 提供已安装插件列表。具体模型是否可用仍由账号和组织配置决定，CLI 没有稳定的套餐额度接口，工作台提供官方额度页入口。

验证入口：

- `tests/session-settings.test.ts`：两个提供方的模型参数、原生会话延续、引用保留、无自动重发、草稿、运行中切换及持久化。
- `scripts/composer-smoke.mjs`：两个提供方的模型/权限/能力菜单、Codex 结构化 Skill 与 Plugin 提及、Cursor `/skill`、MCP 状态与独立设置、单条消息清空、失败重试、运行中切换、草稿、键盘与 1100×760 布局。
- `scripts/composer-tools-smoke.mjs`：两家的“＋”菜单、命令、Skill 引用、Shift+Tab、计划展示/修改/执行、MCP 状态与独立管理、键盘及中文输入法和草稿保留。
- `scripts/codex-mcp-protocol-smoke.ts`：独立测试目录中的真实 Codex 配置写入、版本校验、重载、STDIO 工具发现、启停、编辑、删除和模式查询，不登录账号、不发起模型任务。
- `tests/codex-mcp.test.ts`：分页、配置来源边界、精确写入、OAuth 完成/失败、输入校验及敏感信息过滤。
- `tests/provider-capabilities.test.ts`：Codex 原生目录解析、不可调用应用状态、Cursor 命令过滤、真实插件发现与 MCP 分离。
- `scripts/permissions-smoke.mjs`：原生权限名称、切换及批准请求、只读影响、Cursor 禁用选项与显式配置。
- `scripts/codex-isolation-smoke.ts`：真实 Codex CLI + 本机模拟模型服务，确认切换后的模型请求包含历史上下文，保持桌面会话隔离；不消耗在线模型额度。

- `tests/session-mode.test.ts`：原生模式参数、运行中切换、原会话执行/修订计划、旧计划保护、草稿与权限独立、持久化及旧 CLI 降级。
- `tests/cursor-mcp.test.ts`：项目权限边界、配置保留、独占锁、编辑/删除及连接状态。
