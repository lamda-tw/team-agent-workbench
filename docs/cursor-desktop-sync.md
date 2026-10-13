# Cursor Agents 联动（Beta）

普通用户版的 Cursor 原生联动现在适配 **Agents Window**。从工作台新建、接入、打开及续聊本地 Agent，使用 Cursor 桌面账号；无需 Cursor Agent CLI 登录。仍使用原有用户版启动入口。

## 使用方式

1. 在 **Beta 功能** 中开启 **Cursor Agents 联动**。设置属于当前团队账号；关闭开关不解除已有会话关联。
2. **新建工作会话** → 选择 Cursor、本机网络，勾选 **联动 Cursor Agents**。首次发送或点击 **在 Cursor Agents 中打开 · Beta** 时，在对应项目下创建原生 Agent。
3. 接入已有会话：左侧 **接入 Cursor 会话 → Agents 会话**，按原生项目目录勾选本地会话。**打开 Cursor Agents** 可启动联动窗口。原有 **CLI 会话** 列表独立保留。
4. 首次联动时，如果普通 Cursor 已在运行，请先保存并退出，再从工作台打开联动。工作台使用 Agents Window 启动参数，不结束用户进程、不修改安装文件或原生数据库、不绕过账号开关。
5. 同步、发送前，在 Agents Window 中打开对应 Agent 面板；可以同时打开多个不同 Agent。点击工作台的 **在 Cursor Agents 中打开** 会定位该会话。模型、模式、工具、权限、授权和提问均在 Agents 内处理。
6. 关闭工作台仅断开连接，不停止原生任务。重启后恢复已关联且仍打开的会话；不会创建替代聊天。

新建需要 Agents 侧栏已有对应的本地项目分组。如果项目尚未出现，请在 Agents 侧栏添加并展开完整目录。新草稿应选择当前本地目录；Cloud、Private Worker 和首次发送时新建工作树的草稿不作为发送目标。已有本地工作树会话按其实际绝对目录关联。

## 会话和目录边界

- 根据 Agents 页面配置、原生 Agent ID、每条会话的完整本地工作目录确认身份。Agents Window 可包含多个项目，不能用窗口级目录代替各会话目录，也不根据标题或项目名猜测。
- 每个面板独立读取消息、输入状态和停止按钮，排除嵌套子 Agent 的内容。旁边面板有草稿或正在回复，不影响向目标面板发送。
- 同一 Agent 在多个窗口或多个面板重复打开时，不作为自动发送目标。远程、多根工作区、Cloud 和 Claude Code Agent 暂不支持。
- 已有草稿、正在回复、目录改变、身份无法确认或输入焦点改变时停止发送。提交使用目标面板的原生发送按钮；送达未确认不自动重发。
- 新建 Agent 最初可能是草稿 ID。首次发送后，只有原面板出现新的本地会话及本次用户消息，才接纳正式 ID；工作台保存新 ID 并更新本机连接描述后再确认送达。不能通过相同标题或相同文本猜测另一个既有会话。
- 只同步原生面板当前已加载、可见的用户和助手消息，按消息 ID 合并，不删除工作台已保留的屏幕外历史。尚未覆盖完整早期记录、工具和思考事件，未发送草稿不进入同步记录。
- 当前仍需原生面板保持打开。原生会话暂不支持自动摘要、项目日志后台更新、自动匹配团队动态、整理成果及派生 Subsession。

## 实现与兼容

普通工作台进程内的 CursorDesktopService 管理生命周期，CursorDesktopCdp 验证并连接 Agents 页面，cursorAgentsPage 负责面板定位，CursorNativeRpc 接入现有会话运行时。内部 cursorDesktopSync 设置及会话字段保留，避免升级丢失已有配置。

适配基于本机 Cursor 3.21.18 的 Agents 页面结构。只在已渲染组件上有限读取 React 视图属性以取得原生会话和项目标识，操作使用原生界面控件；不调用内部仓库服务或受限 Desktop Bridge。Cursor 升级导致结构变化时会拒绝无法核对的操作，需要更新适配。

连接只监听 127.0.0.1；每条关联使用随机访问路径，拒绝浏览器 Origin 和错误请求方法。凭据位于本机用户受限目录。关闭、删除会话或切换团队账号会撤销当前连接访问，不删除 Cursor 自身历史。

原有 IDE 会话关联不会自动迁移成新的 Agent，也不会复制上下文。旧会话只有在 Agents 中以同一原生 ID、同一工作目录打开后才能继续关联；无法确认时提示打开原会话。

## 验证范围

后台测试使用内存 Agents 页面和本机 HTTP/WebSocket 替身，覆盖多项目同名目录、多面板消息隔离、原生项目内创建、草稿 ID 转正式 ID及重启恢复、原生发送与停止、已有草稿保护、焦点变化、送达不明不重发、CLI 免登录、导入去重和关闭工作台不停止任务。

    node scripts/test-background.mjs tests/cursor-desktop-client.test.ts tests/cursor-desktop-service.test.ts tests/cursor-native-rpc.test.ts tests/beta-features.test.ts
    node node_modules/typescript/bin/tsc --noEmit
    node scripts/build.mjs --check

此前 2026-10-13 的四轮双向同步演示针对 Cursor IDE，不代表 Agents Window 验收。本次依据安装包源码核对原生结构并运行后台测试；没有操作用户正在使用的 Cursor。真实 Agents Window 的登录、项目选择、跨端多轮续聊与安装包仍需在独立测试环境或用户安排的空闲时段验收。
