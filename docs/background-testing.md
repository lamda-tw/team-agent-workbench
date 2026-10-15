# 不干扰日常使用的验证方式

默认 `npm test` / `npm run test:background` 只运行后台回归。直接执行 `node scripts/test-background.mjs` 可以避免 npm 的 Windows Shell 中转；脚本也接受单个或多个 `tests/*.test.ts` 路径。

- 协议测试替身使用 `.mjs` 入口，由 Node 直接创建隐藏进程并通过管道通信，不再生成 PowerShell、cmd 或 sh 启动链。
- 测试进程加载 `scripts/background-guard.cjs`：拦截异步与同步子进程创建，只放行测试使用的 Node、Python、Git 和受限的进程清理；禁止 Shell、Electron、浏览器、独立控制台。强制 `windowsHide: true`、`shell: false`、`detached: false`。
- Windows 进程树清理只允许指定本测试进程创建且仍在运行的子进程 PID，不允许按映像名或任意 PID 结束程序。生产客户端不加载此测试钩子。
- 各测试使用临时工作目录和模拟账号，不打开真实 Session、不重启客户端、不模拟鼠标键盘，也不主动改变前台窗口。
- `node scripts/build.mjs --check` / `npm run build:check` 将构建放到新建的系统临时目录，不覆盖运行中的 `dist/user`、`dist/admin`。`npm run check` 采用这一构建方式。
- `launcher-source.test.ts` 只读启动脚本，可由后台测试运行；`tests/startup-process.test.ps1` 通过纯进程替身验证等待、取消与超时，可在当前 PowerShell 中运行 `& .\tests\startup-process.test.ps1`，不创建真实进程或窗口。
- `launcher.test.ts`、需要 Windows 证书生成流程的 `egress.test.ts`，以及需要查询 Windows 进程创建时间的 `codex-process.test.ts` 留在显式的 `test:desktop`；默认后台测试不放行 PowerShell 来运行这些检查。所有 `test:*ui` 以及真实 CLI、启动器冒烟测试也只在独立虚拟机、其他测试机器或用户明确安排的空闲时段运行，不属于后台测试。

此防护用于避免测试误开窗口和误操作正在使用的客户端，不是安全沙盒；不能约束任意第三方二进制自行创建的子进程。测试仍占用 CPU 和内存。用户报告黑底与焦点丢失的确切系统原因尚未确认，不应把后台回归通过描述成已修复显卡问题。

2026-09-22：第一轮直接 Node 启动的 13 项测试通过，用户确认没有再出现黑底、选中丢失或输入中断。后续沿用后台验证，不做桌面复现。 随后的后台回归 169 项全部通过；类型检查与隔离构建通过，未启动桌面测试。
