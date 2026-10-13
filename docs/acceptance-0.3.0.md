# 0.3.0 用例与验收范围

本表按用户指定的 8 个问题组织。自动测试使用真实本地文件、Electron 程序、SSH/SFTP 回环连接和模拟 CLI；Linux 用户管理命令使用可注入失败的测试替身。回环服务只模拟必要权限位与错误，不能替代 Linux ACL/PAM/sshd 联调。

| 问题 | 核心用例 | 自动验证入口 |
|---|---|---|
| 1 成果共享 | Alice 提交后 Bob 可读；Bob 不能覆盖 Alice 成果或向其目录写入；非组成员看不到项目；Bob 不能读 Alice 轨迹；旧 0700 成果目录和 0660 文件在原作者重新连接后修正 | `tests/usability.test.ts`、`tests/workspace.test.ts` |
| 2 多 session | 同目录多个 session，交接路径各不相同；输入、引用和问题答案按会话保存；A/B 切换与重启保持内容；B 异步发送失败时 A 不被改写 | `tests/usability.test.ts`、`scripts/usability-cases.mjs` |
| 3 编辑保护 | 标题、正文、仓库链接和目标目录自动保存；跨页面保留；保存失败仍保留编辑并可重试；交接窗口 X 等待保存；失败时不关闭；退出前重试未完成的写入，仍失败则保留窗口；继续工作仍能自动保存；Windows 短暂文件占用重试、永久失败保留原文件 | `tests/core.test.ts`、`tests/usability.test.ts`、`scripts/usability-cases.mjs` |
| 4 并发认证 | 复现同提供方两个目录检测相互取消；给出改造方案、去重/限流/代次隔离与验收表 | 历史复现工具已移除；方案见 `auth-concurrency-plan.md`。0.3.0 未修复，当前验证使用 `tests/provider-auth.test.ts` |
| 5 离线本地工作 | 首次未经远端验证禁止进入；验证成功后离线重启可用；连接修改失败仍可新建本地会话；远端创建/上传仍要求在线实际授权 | `tests/workspace.test.ts`、`tests/usability.test.ts`、`scripts/smoke.mjs` |
| 6 仅交仓库引用 | ZIP 恰含 README 与元数据；保存链接与修改说明；本地代码快照、来源绝对路径、交接文件和会话输入不进入成果包；旧附件也不上传；拒绝无链接、错误域名、含凭据/查询参数的链接；提交期间锁定版本并拒绝重复提交 | `tests/core.test.ts`、`tests/usability.test.ts`、`scripts/usability-cases.mjs` |
| 7 管理员恢复 | 第二个组创建失败；ACL 配置失败；密码设置失败；成员组调整后旧连接终止失败；初始化早期/目录建立后失败；恢复不会重复建号建组；GID/UID 改变拒绝继续；外部已有资源不接管；恢复记录没有密码；失败后主进程刷新实际状态 | `tests/test_admin.py`、`tests/admin.test.ts`、`scripts/admin-cases.mjs` |
| 8 成员开通 | 创建时选组与组管理员；未开通显示缺少步骤；未启用、未完成、未获该组授权不能访问；成员直接使用服务器地址与个人账号登录；客户端不接收密码、sudo 凭据或宿主根路径配置文件 | `tests/usability.test.ts`、`scripts/admin-cases.mjs` |

## 在本机执行

```powershell
npm run check
python -m unittest discover -s tests -p test_admin.py
npm run test:ui
node scripts/test-background.mjs tests/provider-auth.test.ts
node scripts/smoke.mjs --packaged
node scripts/check-packaged.mjs
```

开发构建和打包后的 EXE 使用相同的界面用例。测试通过后以 `VERIFICATION.md` 记录实际结果与交付校验值，不能把方案中的未来验收项计入已通过数量。

## 目标服务器与迁移验收（需要目标环境，尚未执行）

1. 在专用 Linux 测试机安装 Python 3、OpenSSH、acl、passwd/shadow、procps；创建一个普通 sudo 管理账号。分别使用 root 与 sudo 完成初始化、建组、建号与成员登录。核对 `/etc/passwd`、`getent group`、`getfacl` 和实际 SFTP 读写。
2. 用两个组内成员和一个组外成员重做问题 1。分别对新目录和 v0.2.1 已有成果目录验证；成员重新连接后修复其旧目录，未重新连接的旧作者目录保持原权限，需其登录或由 Linux 管理员按相同权限修复。root 仍有系统管理权限。
3. 在测试环境临时使 `groupadd`、`chpasswd`、`setfacl` 的指定步骤失败，恢复环境后通过“继续完成”验证；中断 SSH 后重新连接核对完成阶段。核对恢复记录和日志没有明文密码。
4. 验证实际 SSH drop-in、PAM、sudo 策略与 SSH 服务重载，包括故障时配置回滚；确认成员只有 SFTP 访问。
5. 另一台 Windows x64 安装两个安装包并同时运行，在用户版填写服务器地址和个人 SSH 账号、选择本机目录，分别登录个人 Cursor/Codex 账号完成真实任务。新建多个 session，离线重启后核对本地输入、阶段摘要和草稿。

以上外部场景有明确用例，但没有目标服务器凭据和第二台电脑，当前不能声称已完成环境联调。
