# Cursor 原生会话联调记录

Cursor 原生聊天联动暂未接入普通用户端工作流。仓库统一使用 `start-user-dev.cmd` 和 `start-admin-dev.cmd` 两个启动入口；用户版中的 Cursor CLI 会话仍按现有流程创建。本文保留此前原生界面实验的验证记录，不作为当前功能的使用步骤。

## 实验方式与边界

此前实验通过仅监听 `127.0.0.1` 的本机调试连接，操作 Cursor 自带的 Agent 输入框并读取可见消息，使用原生程序的个人账号，没有修改安装文件、数据库或账号开关。专用实验启动器及启停脚本现已删除；传输协议、界面适配代码与自动用例保留，供后续接入验证。

- 关联的原生聊天必须保持打开；切换聊天、输入框已有草稿、同时显示多个 Agent 或正在回复时，拒绝发送。
- 模型、模式、Skill、MCP、权限及审批在原生界面控制。原生登录不代表 Cursor CLI 已登录。
- 原生会话暂不支持自动摘要、自动匹配团队动态、整理成果和派生 Subsession。
- 按原生消息 ID 合并可见消息，不删除已记录的屏幕外历史；未覆盖完整的早期记录、工具和思考事件。
- 未确认送达时不自动重发；界面选择器失效时停止发送，不切换为其他后台写入。

## 已验证的范围

2026-10-13，在本机 Cursor 3.21.18 的原生 IDE Agent 中完成四轮验证：原生端记住 A，工作台查询 A，工作台记住 B，用户在原生端查询 B。回答分别为 `CURSOR_NATIVE_A_1013` 和 `CURSOR_NATIVE_B_1013`，工作台记录全部四轮，共 8 条消息。重启实验环境后，工作台再次通过原生会话收到 `CURSOR_NATIVE_RESTART_OK_1013`。

保留的自动用例覆盖连接身份与目录校验、连接过期、其他会话拒发、草稿保护、运行中拒发、多个会话面板拒发、失去确认不重发、关闭工作台不停止原生会话，以及 CLI 登录不拦截原生发送。界面用例使用模拟原生页面，不调用真实模型：

```powershell
node scripts/test-background.mjs tests/cursor-native-rpc.test.ts
npm run test:cursor-native-ui
```

Cursor 的官方 Desktop Bridge 尚未对联调账号开放。以上记录属于原生界面的实验验证，后续正式接入仍需单独验收。[Cursor 官方支持说明](https://forum.cursor.com/t/enable-desktop-bridge-desktop-bridge-for-my-account/173277)
