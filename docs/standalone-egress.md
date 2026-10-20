# 独立开机转发脚本

`scripts/standalone-egress.ps1` 把已配置的管理端出口迁移为独立的 Windows 开机计划任务。任务以 SYSTEM 身份启动，不需要登录 Windows 桌面，不需要运行管理端脚本或窗口。Node 运行时和转发程序复制到 `%ProgramData%\TeamAgentStandaloneEgress`，以后启动不依赖源码目录、npm 或 Electron。

接入码不变：安装只读取原配置，复制原访问密钥、TLS 证书及监听地址、端口，不生成新身份。已配置的反向隧道保留原服务器身份和内部端口，原 TAE1、TAE2 接入码继续使用。缺少身份文件或无法解密会终止安装，不自动重置。

## 安装

1. 确认管理端原出口已经保存并启用，现有接入码可用。使用反向隧道时，先在管理端完成隧道和成员授权。
2. 关闭管理端。使用原 Windows 账号，以管理员身份打开 PowerShell；安装需要 Node.js 22 或以上及仓库已安装的依赖。
3. 在仓库目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\standalone-egress.ps1 -Action Install
```

原数据目录默认是 `%APPDATA%\TeamAgentAdmin`；若使用其他目录，附加 `-AdminDataDirectory "完整路径"`。系统会通过一次性无窗口 Electron 辅助进程解密原账号保存的配置，不启动管理界面。不要改用另一 Windows 账号安装，否则原凭据可能无法解密。

若原配置启用了反向隧道，脚本会要求输入该 SSH 账号的密码；输入不会回显。独立任务需在无人登录时自行认证，因此这份凭据与出口密钥一起使用 Windows DPAPI 机器级加密保存。安装目录仅 SYSTEM 和本机管理员可访问。密码不会出现在任务参数、状态文件或命令行中。

安装完成即请求启动，并注册开机触发器。进程失败后计划任务每分钟尝试重启；普通反向隧道断线继续按原逻辑重连。认证失效或服务器身份改变需要重新配置，不会自动接受新身份。用下面的 Status 核对是否真正运行；显示安装完成只说明任务已注册。

## 日常操作

在管理员 PowerShell 中使用安装后的脚本：

```powershell
$relay = "$env:ProgramData\TeamAgentStandaloneEgress\standalone-egress.ps1"
& $relay -Action Status
& $relay -Action Stop
& $relay -Action Start
& $relay -Action Uninstall
```

`Status` 显示计划任务状态、出口监听状态及反向隧道状态；过期状态会标记 `stale`，不当作在线。它不验证外部模型账号是否可用。`Stop` 会停止转发并禁用自动启动，`Start` 会恢复二者。`Uninstall` 注销开机任务、删除独立任务保存的加密凭据副本，保留管理端原接入码、证书和配置；重开管理端后可恢复原运行方式。

托管期间，使用本次更新后的管理端会显示“独立后台托管”，不会启动第二个出口或轮换接入码；旧版管理端不识别托管标记，应先更新。修改出口设置时，先卸载托管，重开管理端修改并关闭，再执行安装。其他成员正在进行的连接会在迁移或主动停用时中断。

电脑需保持开机和联网，原接入地址仍需可达。如果出口依赖本机的 HTTP/SOCKS5 代理，该上游代理也必须能在 Windows 未登录时运行；这个脚本不会替你启动第三方代理。防火墙规则沿用原部署；独立任务使用复制的 `node.exe`，若防火墙原来只按管理端程序放行，需要允许该程序的原出口端口。

## 验证范围

后台测试验证身份导出不改动原文件、旧接入码跨转发进程重启仍可认证、反向端口复用、凭据校验、管理端避让与禁止误改配置。Windows 任务注册、SYSTEM 下 DPAPI 解密、真实开机及实际跨机器网络仍需在部署机安装后验证；开发验证不注册任务、不重启电脑、不干扰已有出口。
