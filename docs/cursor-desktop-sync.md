# Cursor 原生会话同步（Beta）

这项 Beta 让工作台与 Cursor 自带的 Agent 聊天轮流推进同一条原生会话。没有额外的 Cursor 聊天插件；模型和工具实际运行在 Cursor 桌面程序中，继续使用桌面程序的个人账号。

## 启动与操作

1. 保存工作并完全退出 Cursor。Codex 可以保持打开。
2. 双击仓库根目录的 `start-cursor-native-beta.cmd`。入口显示启动进度，自动构建工作台并打开 Cursor 的原生测试工作区和工作台用户窗口。
3. 工作台要求登录时使用本地联调账号 `sync_cursor`，密码 `123`。它仅用于独立的本地共享区，不是 Cursor 账号，也不连接中心 SSH 服务器。
4. 工作台中选择 **Cursor 原生同步 Beta 验证**。在任一端发送，等回复结束后可在另一端继续；两端使用同一个原生会话 ID。
5. **在 Cursor 中设置 · Beta** 切回原生窗口。模型、Agent/Plan 模式、Skill、MCP、权限，以及模型的授权或提问，都在 Cursor 原生界面操作。

已关联的原生会话不检查 Cursor CLI 登录，不会弹出 CLI 的“账号未登录”。如果 Cursor 原生程序本身要求登录，请直接在 Cursor 登录个人账号。这项 Beta 不会复制、保存或代填 Cursor 登录凭据。

重复打开入口时，若本次联调仍在运行，会聚焦现有窗口。完全退出 Cursor 后重新启动入口，可能创建新的原生测试会话；先前的原生会话仍保留在 Cursor 内，先前工作台数据保留在各自的联调目录中。

## 使用边界

- Cursor 桌面程序必须保持打开，并显示所关联的原生会话。切换到其他会话、同时显示多个 Agent，或原生输入框已有草稿时，工作台拒绝发送并保留工作台输入。
- 同一条会话须轮流发送。Cursor 正在回复时，工作台不能另起一轮；需要审批或回答时，切回 Cursor 完成操作。
- 本次 Beta 暂不支持从关联会话自动生成阶段摘要、自动匹配团队动态、整理成果或派生 Subsession。不能借原生会话的登录状态去默认为 Cursor CLI 也已登录。
- 上传轨迹仍可使用工作台现有入口。工作台只同步已被读取的可见用户消息和回答，按原生消息 ID 合并，不删除已记录的屏幕外历史。首次关联长会话不能保证自动补齐所有早期记录，工具和思考事件也未完整采集，暂不适合作为完整训练轨迹导出。
- 未确认送达时不自动重发，先在 Cursor 核对有没有收到，避免重复执行。

## 停止与恢复

双击 `stop-cursor-native-beta.cmd` 可停止工作台与原生窗口之间的同步后台，不会停止 Cursor 本身的会话。恢复使用时，先完全退出 Cursor，再打开启动入口。

Beta 通过本次启动专用的本机调试连接操作 Cursor 的真实聊天输入框并读取可见消息，没有修改 Cursor 安装文件、数据库或账号开关。调试连接仅监听 `127.0.0.1`；工作台使用会话与工作目录匹配的随机访问凭据，凭据文件仅限当前 Windows 用户访问，连接最多有效 24 小时。该调试端口本身可被本机其他程序访问，因此只建议在个人联调环境使用。退出 Cursor 并按普通方式重新打开即可取消本次调试启动。

Cursor 界面改版后选择器可能失效；此时停止发送，不能静默改为 CLI、创建另一条会话或写数据库。启动问题查看 `.test-data/cursor-native-beta/logs/`，后台问题查看 `.test-data/cursor-native-beta/manager.log`。

## 已验证的范围

2026-10-13，在本机 Cursor 3.21.18 的原生 IDE Agent 中，使用现有个人账号完成四轮验证：原生端记住 A，工作台查询 A，工作台记住 B，用户在原生端查询 B。回答分别为 `CURSOR_NATIVE_A_1013` 和 `CURSOR_NATIVE_B_1013`，工作台记录全部四轮，共 8 条消息。重新启动入口后，工作台再次通过原生会话收到 `CURSOR_NATIVE_RESTART_OK_1013`。

自动用例覆盖会话/目录/网络出口校验、连接过期、拒绝其他会话、草稿保护、原生运行中拒发、多个会话面板拒发、失去确认时不重发、关闭工作台不停止原生会话、登录后替换本地记录、以及 CLI 登录不拦截原生发送。执行：

```powershell
node scripts/test-background.mjs tests/cursor-native-rpc.test.ts
node --import tsx scripts/cursor-native-ui-smoke.ts
```

Cursor 的官方 Desktop Bridge 尚未对当前账号开放。这项 UI 联动属于独立的 Beta 实验；它的稳定性和后台能力不能按官方接口承诺。[Cursor 官方支持说明](https://forum.cursor.com/t/enable-desktop-bridge-desktop-bridge-for-my-account/173277)
