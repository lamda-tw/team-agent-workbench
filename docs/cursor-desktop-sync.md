# Cursor 会话一致性与当前边界

## 必须满足的两项原则

1. 关联的工作台 Cursor CLI 会话和 Cursor Agents，会有同一份完整、有序的原生历史。正常传输延迟结束后，不得漏消息、重复消息或以相同标题、文本猜测会话身份。
2. 无论从哪边继续，都使用同一个原生执行状态，行为等同于在单一原生会话中操作。工具结果、权限和提问、模型与模式设置、上下文压缩及压缩后的恢复均由同一原生执行者负责；一轮任务只执行一次。

工作台只管理会话和消息，不自行重建另一套上下文、不生成用来替代原生压缩的摘要、不把两份独立运行的历史文件拼起来当作共享执行状态。

## 当前功能

- 普通 Cursor CLI 会话仍可以创建、导入和继续。它们是 CLI 的原会话，不能与 Agents 当作一条会话交替执行。
- 新建窗口的 **联动 Cursor Agents** 显示为 **暂不可用**。Beta 开关不能新开启，旧的已开启设置可以关闭。
- 旧关联、原生 ID、已保存消息和本地草稿保留。工具栏明确显示 **仅查看已加载记录**，不宣称完整同步。**重新读取** 只重连原来的观察通道；**在 Cursor Agents 中打开** 仍定位原会话，不创建替代 Agent。
- 旧关联会话的发送按钮禁用，回车也不会发送。用户可在 Cursor Agents 原生面板继续。窗口未加载的历史、工具和思考记录不能被此观察通道完整读取，不能作为完整会话验收。
- CLI 会话的 **在桌面端显示** 禁用，服务端也拒绝该操作，不向 Cursor 的会话数据库写入合成记录。
- 关联断开、身份丢失或描述文件过期时，不回退到独立 CLI、不自动重发，也不切换到其他原生 ID。关闭工作台只移除观察连接，不停止原生任务。

## 为什么暂不可用

本机检查的是 Cursor 3.24.12 和 Cursor Agent CLI 2026.09.10-fd3934a。CLI 帮助没有接入原生桌面 Agent 的命令。Cursor 官方在 2026-09-29 说明 Desktop Bridge / `cursor desktop` 仍是未向客户账号开放的内部开发能力，并说明 CLI 会话管理命令不能接入桌面 Agent，参见 [官方支持说明](https://forum.cursor.com/t/enable-desktop-bridge-desktop-bridge-for-my-account/173277)。2026-10-14 核对最新公开发布说明，未找到这一能力已经对外开放的证据。

现有 Agents Window 适配操作原生控件，并读取已加载的视图消息；这可以验证面板身份与部分消息，不能证明真正的 CLI 和 Agents 共享完整模型状态。因而这轮修改落实了拒绝不满足原则的路径，尚未实现两端完整关联。不能把打桩通过当作原生端到端验收。

## 实现和验证

共享能力边界由 src/shared/cursor-session-consistency.ts 定义。界面、工作台业务层、AgentRuntime、CursorNativeRpc、本机窗口连接服务，以及低层桌面登记均拒绝不满足条件的发送或登记。拒绝发生在创建替代会话、构造补充上下文、写入新消息或启动 CLI 之前。

后台用例覆盖：新建、Beta 开启、批量导入和任务启动的拒绝；旧关联续聊的非修改行为；低层窗口发送与桌面登记的拒绝；历史、原生 ID、草稿和原生任务的保留；观察通道按原 ID 恢复；普通 CLI 入口保留；Cursor 不再显示“同步中”；发送按钮和回车不可发送。Codex 的共享后台流程单独验证。

    npx tsx --test tests/cursor-desktop-client.test.ts tests/cursor-desktop-service.test.ts tests/cursor-native-rpc.test.ts tests/cursor-session-consistency.test.ts tests/beta-features.test.ts tests/codex-shared-runtime.test.ts tests/codex-desktop-service.test.ts tests/native-sessions.test.ts
    npm run typecheck
    npm run build

恢复完整关联前，需要一个实际可用的原生共享会话接口，并完成双向多轮、工具调用、授权、上下文压缩、重启恢复和并发发送的真实验收。版本更新、相同 UUID 或相同聊天文字均不自动解除能力限制。
