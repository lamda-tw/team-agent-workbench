# Cursor 原生历史数据源调试记录

验证日期：2026-10-14。初期环境：Windows、Cursor 3.24.12、原生 Agents 窗口，模型 Grok 4.7 High Fast。后续受控普通 IDE 验证使用 Auto；彻底退出后的安装版本为 3.24.18，版本变化单独记录。

## 本轮结论

本文按调试发生顺序保留记录。**最新产品状态见 [Cursor 原生联动使用说明](cursor-desktop-sync.md)**：普通 IDE 已接入工作台，双向续聊、排队、原生压缩、停止与恢复均有本机证据。下文初期“尚未接入／禁用”的结论只描述当时路径，不能作为当前功能状态。

**本机 Cursor 的原生历史、工具调用和工具结果可以从本地持久化数据读取。之前的窗口适配没有接入这些数据源，不能把这个实现缺口解释成 Cursor 本身无法提供数据。**

已增加只读读取原型和调试入口，尚未接入工作台的联动功能。读取成功不代表独立的 Cursor CLI 已经能继续桌面 Agent 的执行状态，也不会自动解除当前发送限制。

后续已验证独立普通 IDE 会话在同一后台内手动压缩、续聊，以及完全退出 Cursor 后的跨版本恢复。完整历史与当前执行摘要均保留。早期 Agents 跨后台路径仍未通过；工作台的双入口发送、互斥排队、授权及产品重启恢复尚未完成原生验收。以下按验证发生的顺序保留证据，不把后面的受控通过覆盖前面不同路径的失败。

## 数据分别保存在哪里

当前 Windows 账号的数据库：`%APPDATA%\Cursor\User\globalStorage\state.vscdb`。

| 数据 | 当前验证的数据源 | 用途与限制 |
| --- | --- | --- |
| 原生会话身份、工作目录、消息顺序 | `cursorDiskKV` 中的 `composerData:<原生 ID>` | 按 `fullConversationHeadersOnly` 的顺序取消息，不按数据库行号、标题或文本猜关联。 |
| 界面历史记录 | `bubbleId:<原生 ID>:<消息 ID>` | 包含聊天文字、思考记录、工具元信息和原生压缩标记；不依赖当前面板是否显示。 |
| 原生持久化的提示消息 | 根记录的 `conversationState`，以及它引用的 `agentKv:blob:<内容 ID>` | 解码后有用户消息、助手内容、工具参数、调用 ID、工具结果；是原生已保存的消息，不等于完整的可执行运行环境。 |
| 较大的原始文件读取结果 | 工具结果里的 `contentBlobId` 引用的 blob | 需要额外读取这个引用。界面工具元信息可能只含行数，格式化的模型结果与原始文件内容也可能不同。 |
| 压缩前归档的消息 | 状态中的 `summary_archives` 引用 | 原型按原生引用读取归档，与当前提示消息分开返回。后续自动压缩测试已读到实际归档；手动压缩路径仍有引用覆盖缺口。 |

旧验证会话有 12 条原生界面记录，其中 8 条为聊天文字、4 条为思考记录。这两个数量的差异不能解释为漏了 4 条用户或助手文字消息。

## 真实验证做了什么

在原生 Agents 窗口创建独立测试会话，只使用专用验证文件，没有运行项目任务。三轮对话始终由同一个原生 Agent 执行，未用独立 CLI 生成另一份回复。

1. 让原生 Agent 读取一个 296 字节的文件。实际执行了 `Glob` 和 `Read`，返回预设的三个标记。
2. 让同一 Agent 读取一个 18,555 字节的文件，返回末尾标记。实际又执行了 `Glob` 和 `Read`。
3. 切到空白新聊天，验证原会话未显示时仍能读取其历史；再打开同一原生 ID，要求不使用工具回忆两个文件的标记，回复正确，工具调用数保持为 4。

只读读取原型核验了四次调用的参数和结果 ID 配对，两个文件的原始工具返回内容都与测试文件逐字节一致。长结果没有被工作台原有的文本显示长度限制截断。最终读取到 20 条原生界面记录、16 条原生提示消息，没有缺失引用。这两种记录有不同粒度，不能直接比较数量来判断漏消息。

也执行了原生 `/compact`。窗口显示了压缩标记，但该短会话没有产生 `summary_archives`，第一次执行前后的持久化状态没有变化。因此本轮**没有验证真实上下文压缩完成**，不把界面标记当作成功证据。

第一轮详细校验结果在忽略目录 `.test-data/cursor-history-data-audit/live-verification.json`。其中明确区分了已验证的读取、原生续聊，以及当时未验证的真实压缩和 CLI 恢复执行。

## 初次真实压缩验证：跨后台路径未通过

用户要求：压缩后的恢复验证通过前，Cursor 联动保持不可用。当前所有发送与新关联限制继续保留。

在同一原生会话中加入四项待保留约定，再读取两个合成文件，将上下文增加到约 41%。执行 `/compact` 后，确实发生了持久化状态变化：

| 阶段 | 原生提示消息引用数 | 摘要归档数 | 界面上下文占用 |
| --- | --- | --- | --- |
| 压缩前 | 23 | 0 | 约 41% |
| 压缩完成 | 3 | 2 | 约 6% |
| 切走、重新打开、续聊后 | 25 | 0 | 约 41% |

续聊正确回答了四项约定，但压缩后的状态没有保持。因此不能用“回答正确”判定恢复通过。此现象在原生窗口直接操作时出现，没有使用独立 CLI 或工作台摘要重建上下文。后续已定位到本机版本的后台路由分流，见下文；不能据此断言所有 Cursor 版本都有同样的问题。

另外，压缩后的当前提示消息与摘要归档只引用了此前六次工具调用中的两次完整结果。原始界面记录仍在；按原生调用 ID 的只读探查，另外四次结果也仍存在数据库中，但未被当前摘要引用。安装版本的存储代码还会清空界面工具记录中的内联文件内容。因此只读原型现在显式报告 `historical-tool-result-not-referenced`，不再把“所有已找到引用都能读”误判成“完整历史已经找到”。后续需要补齐历史数据源和保留策略，并验证恢复与清理后的完整性。

最初的自动压缩尝试没有调用手动压缩命令：继续读取四个合成文件后，Grok 窗口显示 100%，仍能续聊，但当时尚未观察到自动摘要归档。窗口显示百分比和每轮累计输入 token 都不能单独证明自动压缩触发。

Sonnet 对照被供应商地区限制拒绝：原生窗口显示 `This model provider is not supported in your region`，消息仍在输入框，没有新增执行记录。这项记为模型不可用，不算压缩测试失败。[Cursor 地区说明](https://cursor.com/docs/account/regions) 建议使用可用模型或 Auto；随后通过原生模型菜单选择 Auto，没有更改地区、网络或账号。

### Auto 路径：已观察到真实自动压缩及重新打开后的续聊

Auto 能正常回答项目名与下一步任务。为进一步区分手动状态与运行状态，在同一原生窗口执行 `/compact`，得到 3 条提示消息引用、3 个摘要归档、约 6% 上下文占用；立即续聊，未切换会话，也未再发送手动命令。

这轮续聊产生了原生 `preCompact` 事件：`trigger=auto`，266,918 个上下文 token、256,000 的窗口、37 条运行消息、35 条待压缩消息。随后生成新的原生摘要和完整历史归档，四项约定、六个文件标记均回答正确。

| 阶段 | 原生提示消息引用数（含系统消息） | 摘要归档数 | 已引用的历史工具结果 |
| --- | --- | --- | --- |
| 最后一个未压缩快照 | 36 | 0 | 10/10 |
| 自动压缩并完成回复 | 7 | 1 | 10/10 |
| 切到空白聊天、重新打开同一 ID、再次续聊 | 9 | 1 | 10/10 |

重新打开后，当前原生摘要的 blob ID 和内容都保持一致，上下文仍约 5%，十次工具结果及较大的原始内容 blob 与未压缩快照一致，原有界面消息顺序保留。续聊未重新调用工具，四项约定和六个文件标记全部正确。当前导出省略系统消息，因此 JSON 中当前消息与归档消息数分别比原生引用少一条，不以此判定漏历史。

进一步核对原生 `stop` Hook 的输入量：旧大上下文中的一次无工具回忆轮次记录 `input_tokens=269851`；自动压缩完成的回复轮次为 `13823`；重新打开后的无工具回忆轮次为 `14136`。这与当前提示消息由完整旧对话替换为原生摘要相吻合，证明对话输入量实际减少，证据不只来自界面百分比。该字段是原生 Hook 报告的轮次输入量，不是抓取出的网络请求，也不代表摘要生成及所有调用的总费用。数字与执行 ID 对应记录在 `.test-data/cursor-history-data-audit/compaction-token-evidence.json`，可用 `.test-data/cursor-compaction-token-audit.cjs` 重查；只导出选定测试轮次的数值字段。

这证明本轮**自动压缩后切换会话并续聊的路径通过**，尚未覆盖退出 Cursor 进程再启动，也不是工作台双端端到端验收。自动压缩事件发生在同一会话先做手动压缩之后，报告保留这个前提，没有把它描述成完全独立的自动测试。

手动路径仍未通过：原生界面及持久化快照已经显示压缩后只有 3 条提示引用，下一轮原生执行却报告 37 条运行消息并再次触发首次自动压缩，生成了另一份摘要；手动阶段只引用了十次工具结果中的两次。工作台未写入 Cursor 数据或拼接替代上下文，联动限制继续保留。

### 进一步定位：手动命令和普通对话进入了两个后台副本

本机 Cursor 3.24.12 的原生 Agents 窗口中，同一个原生会话 ID 被全局工作台与项目工作区的两个 Agent Host 分别加载。三次实际手动压缩全部在全局后台执行，普通对话及自动压缩在项目工作区后台执行。这不是根据窗口百分比推测，原生日志同时记录了原生会话 ID、动作类型、执行 ID 和后台所属工作区。

| 本地时间 | 动作 | 执行后台 | 后续现象 |
| --- | --- | --- | --- |
| 09:18:52 | 第一次 `/compact`，`summarizeAction` | `window1_wb0`，全局后台 | 全局后台首次创建该会话副本。 |
| 09:37:34 | 长对话后的 `/compact`，`summarizeAction` | `window1_wb0`，全局后台 | 摘要归档只覆盖较早的两次工具结果。 |
| 09:44:32 | 普通续聊，`userMessageAction` | `window1_wb1`，项目后台 | 项目后台继续自己的未压缩状态，再写回持久化镜像。 |
| 10:26:56 | Auto 下再次 `/compact`，`summarizeAction` | `window1_wb0`，全局后台 | 持久化镜像显示压缩后的旧副本。 |
| 10:28:21 | 普通续聊，`userMessageAction` | `window1_wb1`，项目后台 | 在真正执行对话的副本中触发 `preCompact(auto)`；后续压缩恢复正常。 |

安装代码与这个分流吻合：

1. 新原生输入框的 `use-prompt-submit-with-suggestion.react.js` 分支识别 `/compact` 与 `/summarize` 后，直接调用 `composerChatService.triggerManualSummarization` 并返回，跳过普通消息的 `onSubmit` 回调。该服务通过 `et(a0)` 取得；`a0` 是 `composerChatService`，`et` 明确使用窗口的 `WT().workspace` 解析服务，而不是当前 `agentReference` 所属的项目工作区。
2. `AgentHostService._ensureSession` 对已创建的后台会话直接复用；仅冷启动时导入 `initialHistory`。因此全局后台里的老副本不会在每次手动压缩前刷新成项目后台的最新状态。
3. 手动 `summarize` 没有设置 `historyRewrite`，发送动作时不附带 `baseHistory`。Host 端只有收到 `baseHistory` 才执行 `rebase`，本次不存在用当前镜像替换旧后台状态的步骤。
4. 两个后台的检查点都经 `handleConversationCheckpoint` 更新同一条 `composerData:<原生 ID>.conversationState`。所以全局后台写入压缩状态后，下一轮项目后台又写回它自己的状态，形成之前看到的回退。

因此，本轮异常定位到**后台归属与命令路由**：手动压缩处理的是另一个旧副本，普通续聊继续当前项目的副本。自动压缩在普通对话的原生执行链内完成，所以能保持同一份状态。数据库读取器正确观察到了镜像变更，但仅检查原生 ID、工作目录和这条镜像，仍不足以证明它来自当前权威后台。

修复方向是让对话、手动压缩、授权与结构化回答都发往会话所属项目的同一个原生后台，并从该后台取得确认后的检查点。关联信息需要包含原生会话 ID、工作区和后台归属；不能为了压缩另建副本、强行写数据库，或把旧历史重新喂给独立 CLI。绕过输入框的全局命令分支、直接在所属后台发送原生 `summarizeAction` 是可验证的候选路径，尚未实际调用，不能宣称修复完成。升级 Cursor 或改用单工作区 IDE 模式的效果也尚未验证。

定位证据在忽略目录 `.test-data/cursor-history-data-audit/manual-routing-diagnosis.json`。`.test-data/cursor-manual-routing-proof.cjs` 可重新核对三次手动动作、三次续聊、源代码的缓存复用和状态重置条件；断言不满足就失败，不读取登录信息，不修改 Cursor 文件或数据库。报告包含安装源码 SHA256 与定位字符偏移，记录只针对本机这个版本。

手动与自动的机制说明：[Cursor 官方支持答复](https://forum.cursor.com/t/squeeze-button-compact-the-current-chat-in-place-instead-of-starting-a-new-session/168985) 表示 `/summarize` 使用与自动压缩相同的摘要机制；本机输入处理代码将 `/compact` 与 `/summarize` 路由到同一入口。两者触发时机不同，[官方 `preCompact` 文档](https://cursor.com/docs/hooks#precompact) 用 `manual`、`auto` 区分触发来源。因此需要分别验证实际触发、压缩状态提交、恢复、历史及工具结果，不假定一次手动测试覆盖自动路径。

后续结果：`.test-data/cursor-history-data-audit/compaction-verification.json`；原始阶段快照为 `manual-before-large.json`、`manual-at-41-percent.json`、`manual-after-recall.json`。报告保留失败与未验证状态，不自动开启任何联动能力。

## 代码与重复检查

- `src/core/cursor-desktop-history.ts`：实验性只读读取器，校验原生 ID 和原工作目录，在一个 SQLite 读取事务内解析记录；缺失、重复或未知格式会返回问题或拒绝读取，不默认为完整。
- `scripts/cursor-native-history-audit.ts`：显式选择一条原生会话的调试入口。默认只打印计数和问题，不启动模型、不调用 CLI、不修改 Cursor 数据库。
- `tests/cursor-desktop-history.test.ts`：12 个用例，覆盖顺序、长结果、中文、内容 blob、归档格式、身份与路径不匹配、缺失引用、旧编码、坏数据、只读、运行中状态，以及压缩后缺失历史工具结果的显式报告。
- `src/core/cursor-compaction-verification.ts` 及对应 8 个用例：比较实际前后快照；界面标记不足以通过，续聊正确不足以掩盖状态回退，工具元信息不足以替代原始结果。另检查原始顺序、结果内容与内容 blob；按同一原生摘要的身份和内容验证状态保持，允许归档容器合并，不要求容器数单调增加。

读取指定原生会话：

```powershell
npx tsx scripts/cursor-native-history-audit.ts --native-id <原生UUID> --cwd <原工作目录>
```

需要查看测试会话的详细记录时，可增加 `--output <新的JSON文件路径>`。导出包含会话内容，应选择本地测试目录。入口拒绝覆盖已有文件，不导出原生系统提示；读取器不返回根记录中的登录信息或 blob 加密密钥。

验证代码：

```powershell
node scripts/test-background.mjs tests/cursor-desktop-history.test.ts tests/cursor-compaction-verification.test.ts tests/cursor-session-consistency.test.ts tests/cursor-desktop-service.test.ts tests/codex-shared-runtime.test.ts
npm run typecheck
```

首轮 38 个相关用例和类型检查通过；后续增加的验证见下文。它们验证读取和拒绝不满足条件的路径，不能替代原生验收。自动路径的实际快照为 `automatic-native-compacted.json`、`automatic-native-reopened.json`、`automatic-native-recovery-state-2.json`；事件在专用测试工作区的 `compaction-events.jsonl`。总报告明确分别记录手动失败、自动通过、Sonnet 不可用，以及联动仍未开放。

## 对后续联动的影响

可以继续探索“一个原生 Agent 负责执行，工作台负责管理、发送入口和历史展示”的路径。使用原生保存的消息读取历史，不再以面板已加载文字作为唯一数据源；也无需为了显示历史自行生成替代原生上下文的摘要。

剩余验证包括：手动压缩状态保持及历史引用覆盖、退出进程后的恢复、授权和结构化提问、其他工具类型及子 Agent 的数据引用、编辑与分支、运行中保存延迟、双方并发发送，以及 Cursor 版本变更。当前读取的是内部存储格式，不能当作稳定公开 API。

独立 CLI 与 Agents 各自执行，再拼接消息文件，仍不满足“执行行为与单一原生会话一致”的要求。若采用一个原生执行者，则工作台中的入口不应再另启动一个 CLI 来执行关联会话。

## 2026-10-14 后续验证：普通 IDE 手动压缩与会话互斥

### 普通 IDE 中已发生真实手动压缩，恢复仍待验证

在 Cursor 普通 IDE 窗口打开同一测试会话，核对原生 ID 和项目工作区后，直接执行原生 `/compact`。这次没有使用 Agents 窗口的全局命令入口，也没有修改 Cursor 安装文件或写数据库。

| 阶段 | 界面记录 | 原生提示引用 | 摘要归档 | 归档消息（省略系统消息） | 完整历史工具结果 |
| --- | --- | --- | --- | --- | --- |
| IDE 手动压缩前 | 57 | 9 | 1 | 33 | 10/10 |
| IDE 手动压缩后 | 58 | 3 | 2 | 39 | 10/10 |

原生 `preCompact` 报告 `trigger=manual`，上下文 14,276 / 256,000 token，9 条运行消息、7 条待压缩消息。实际执行 ID 为 `553a1a8e-bd43-400c-935a-ce274f37818e`。原始文件内容引用仍完整，包括 18,555 字节内容 blob。

证据是 `ide-manual-before.json` 和 `ide-manual-compacted.json`。需要用户在同一个普通 IDE 会话发送恢复问题，再检查摘要保持、十次工具结果、验证词和实际执行后台。在恢复问题尚未执行前，不能把本次结果记为“手动压缩及恢复通过”，也不能证明 Agents 窗口的分流已经解决。

### 用户新增要求：同一关联会话只能有一个修改者

互斥对象是原生会话 ID，两端共享同一个锁。不同会话仍可同时工作。锁覆盖的最终范围应包括发送、手动压缩、编辑重试，以及其他会改变原生执行状态的动作；等待工具批准或用户回答不能释放当前执行权。解锁还需要确认原生执行结束及其状态提交完成，不能以窗口关闭、固定超时或旧请求的结束事件判断。

`scripts/cursor-native-turn-lock.cjs` 是发送锁验证原型，尚未安装到产品工作流。它使用原子文件创建和短临界区，在不同进程之间争抢同一原生 ID 的执行权；用 `generation_id` 核对释放者。被拒绝的发送、旧请求和重复结束事件不能释放后继请求的锁。没有超时自动抢锁。记录中不保存提示词、附件、账户身份或凭据。

只在独立测试工作区配置了原生 [Cursor Hooks](https://cursor.com/docs/hooks)：`beforeSubmitPrompt` 取得执行权，`stop` 按执行 ID 释放原型锁。实际观察到：

1. 原生发送取得锁，模型返回 `CURSOR_LOCK_INIT_1014`，同一次执行的 `stop(completed)` 释放锁。
2. 测试进程模拟另一端持锁后，在原生输入框发送被 `beforeSubmitPrompt` 拦截，显示“这条会话正在执行，请等待完成后再发送”。模型检查点及提示消息哈希不变，原持有者的锁保持；随后由测试持有者显式释放。
3. 十二个独立进程同时争抢同一会话，恰好一个获准。不同会话能独立取得执行权。旧事件、损坏状态、等待回答、不可用存储等边界有用例覆盖。

第二项是“模拟持有者 + 真实原生发送”的混合验证，不是两端产品入口同时发送的端到端验收。证据为 `.test-data/cursor-history-data-audit/native-lock-live.json` 和测试工作区 `turn-lock-events.jsonl`；测试产生的锁已释放。

### 发送 Hook 的限制：不能据此开放完整联动

- 原生发送被拦截前，Cursor 已添加用户消息和 Hook 错误的界面记录。模型上下文不变，但界面历史发生了修改。因此这一检查不能保证“双方都不并发修改历史”。工作台自己的草稿应在取得执行权前保持本地，不追加正式会话消息。
- Agents 窗口的 `/compact` 走前文已定位的独立命令分支，不经过普通消息发送链。官方将 `preCompact` 定义为不可阻止或改变压缩的观察事件；不能用它假装实现压缩前抢锁。需要继续验证同一个权威后台对发送、压缩等所有修改的串行执行。
- `stop` 表示一轮执行结束，本原型尚未证明它也是持久化检查点完成提交的确认。正式接入前不能直接把它当作完整状态提交屏障。
- 本机 Windows 的 Hook 子进程收到的 `workspace_roots` 中中文路径出现不可逆乱码。测试采用已经核对实际工作区的原生 ID 绑定清单限定范围，未猜测修复乱码路径。产品需要持久化可信的会话、工作区与后台绑定，不能靠损坏的路径或标题识别。

这些缺口仍阻止完整 Cursor 联动启用。锁原型不会修改 Cursor 数据库，也没有强行修补原生安装程序。

### 当前相关检查

```powershell
node scripts/test-background.mjs tests/cursor-native-turn-lock.test.ts tests/cursor-desktop-history.test.ts tests/cursor-compaction-verification.test.ts tests/cursor-session-consistency.test.ts tests/cursor-desktop-service.test.ts tests/codex-shared-runtime.test.ts
npm run typecheck
```

共 49 个相关用例通过，类型检查通过。新增读取用例覆盖“首次模型请求前就被拦截”的合法空原生检查点；空检查点不能被报告为完整可恢复的执行状态。检查通过不替代上述待完成的原生验收。

## 2026-10-14 队列选择与测试 Hook 的后续处理

用户确认：另一端在同一会话执行期间发送时，加入等待队列，当前请求完成后自动执行。因此，“繁忙时直接拒绝发送”仅是前述锁原型的探查行为，不是最终产品交互。

`src/core/cursor-native-mutation-queue.ts` 已增加队列原型。两端的待发送内容进入同一个权威后台的队列，按收到顺序执行；待执行消息允许取消。在排队时不复制旧执行上下文，后续消息应使用前一轮提交完成后的原生状态。队列本身不写入原生历史，不启动另一个 CLI，不生成替代原生摘要。

队列区分“请求被后台接收”和“这一轮状态已提交完成”，必须收到同一原生会话、工作区、后台、请求 ID 和执行 ID 的提交确认，才能自动执行下一条。等待批准或回答仍占用当前执行权。发送确认或状态保存不确定时，当前请求保持未确认，后续队列暂停；只能向权威后台核验，不能根据时间、普通 `stop` 或网络重连自动重发。后台明确确认从未开始的请求会标记为未执行，后续请求才可继续。已确认的执行不能被随后矛盾的“未开始”回复解锁。

十个队列用例覆盖双入口顺序执行、接受请求后仍等待状态提交、发送与手动压缩共用队列、取消待执行项、请求去重、丢失确认后不重发、错误后台和执行 ID 拒绝解锁、从未开始请求的核验、不同会话独立推进和窗口关闭。类型检查通过。

该原型尚未接到产品工作流：现在没有经过验收的原生双入口拦截及提交确认接口。它必须运行在两端共用的唯一执行者上，不能在两端分别创建各自的队列。当前队列存于内存，尚未实现重启恢复；重启不能悄悄重放状态未知的请求。上述原生 `/compact` 绕过普通发送入口的问题仍需解决，不能仅根据队列单元测试开放联动。

用户在发送普通 IDE 恢复问题时收到“无法确认这条会话的执行状态，暂未发送”。原生日志确认请求 `232dc0f1-5e07-41dd-a8a7-906a21d8fd45` 被测试 `beforeSubmitPrompt` Hook 阻止，在首个 token 前结束。测试脚本没有留下正常的锁事件，说明发生了脚本异常处理；尚未取得异常阶段证据，不能认定是用户权限或模型服务故障。

已撤下独立测试工作区的锁检查 Hook，保留压缩观察 Hook，并改用不会阻止请求的输入格式诊断 Hook。诊断只记录编码可解析性、字节数和验证用执行 ID，不记录提示词、账户、路径或原始输入。它仅用于找出测试脚本异常，不是新的正式发送机制。用户需要在普通 IDE 中重发恢复问题，再继续检查真实摘要状态；被阻止的请求不能作为压缩恢复失败或通过的证据。

后续已定位本机 Windows Hook 的输入损坏：Cursor 3.24.12 的 `extensionHostProcess.js` 中，`$executeHookDirect` 将 JSON 写为 UTF-8 临时文件，Windows 包装函数 `Dot` 却执行 `Get-Content -LiteralPath '<临时文件>' -Raw`，未指定读取编码。设置 `$OutputEncoding` 只影响后续管道输出，不能修复前面已经按默认编码读取的文本。

在独立验证会话发送中文、让模型只回复验证词时，诊断收到的 968 字节可以严格解码为 UTF-8，但无法解析为 JSON；GB18030 与 UTF-16LE 也不能解析。模型正常完成回复，说明观察 Hook 不再阻止消息，且损坏发生在 Hook 输入链，而不是正常原生对话上下文中。使用原生日志中同一类原始 JSON，在本地直接通过 UTF-8 stdin 重放锁脚本，脚本能正常取得并释放测试锁，没有调用模型。证据分别在 `hook-input-events.jsonl`、`native-hook-chinese-diagnostic.json` 和 `hook-utf8-replay.json`。

此次未修改 Cursor 安装文件，也未尝试通过猜测乱码来恢复丢失的 JSON 字符。正式锁不能在无法解析原生请求时静默放行；发送入口、状态提交确认以及这个 Windows 输入问题都需要先得到可靠处理。当前诊断 Hook 的放行只适用于不关联产品联动的恢复测试。

队列加入后，七个相关测试文件共 59 个用例通过，类型检查通过；生产 Cursor 联动限制继续保留。

## 2026-10-14 14:26 恢复回复的核验：跨后台路径仍回退

用户已完成恢复问题，回复中的四项约定和六个验证词全部正确。只读核验进一步显示原始历史顺序保留、十次工具结果和 18,555 字节文件内容都完整，但新的手动摘要没有保持。

| 阶段 | 原生提示引用 | 摘要归档 | 当前摘要 |
| --- | --- | --- | --- |
| 普通 IDE 手动压缩前 | 9 | 1 | 前次自动压缩摘要 |
| 普通 IDE 手动压缩后 | 3 | 2 | 新手动摘要 |
| 用户完成恢复回复后 | 12 | 1 | 回到压缩前的自动摘要，blob ID 和内容哈希均与压缩前一致 |

不能根据回复正确或提示引用数仍然较少判为通过。这次是从新的手动摘要回到了此前的自动摘要，仍然发生了执行状态回退。

原生日志定位：手动压缩请求 `553a1a8e-bd43-400c-935a-ce274f37818e` 在 `window2` 的普通 IDE 后台执行 `summarizeAction`；恢复请求 `bda8fff5-8479-436f-9ba0-8d6c7ce57045` 进入 `window1_wb1` 的 Agents 项目后台执行 `userMessageAction`。同一原生 ID 和目录不等于同一个执行实例。本次只能判定跨后台续聊失败，尚不能判断在普通 IDE 的同一个后台内压缩和续聊是否正常，也不能仅凭日志断言用户实际点击了哪个窗口。

新证据为 `ide-manual-recovery-1014.json`、`ide-manual-recovery-verdict.json` 和 `ide-manual-recovery-routing.json`；`.test-data/cursor-ide-recovery-routing.cjs` 可核对两次实际动作的后台日志及摘要回退。以上仅为本机 3.24.12 的原生测试，不是工作台联动验收。

已在普通 IDE 创建另一条独立验证会话 `517b66f2-f11b-45a6-bc72-dd9b6780d7bb`，选择 Auto，等待用户完成第一轮合成文件读取。这个新 ID 尚未在另一个窗口执行，用于继续区分同后台路径与跨后台路径，原验证会话和证据保留。

后续联动除了按会话互斥和排队，还必须固定唯一权威执行实例，并确认下一次执行使用前一轮提交后的状态。把请求依次发给两个不同的旧副本，仍会顺序覆盖状态；单独加锁或排序不能解决这个问题。当前队列原型的 `backendId` 应对应实际执行实例与连接生命周期，不能简单用工作区 ID 代替。

### 独立会话第一轮已完成

用户已在「Cursor single owner validation」完成第一轮。原生 ID 为上述 `517b66f2-f11b-45a6-bc72-dd9b6780d7bb`，没有根据标题猜关联。实际 `userMessageAction` 请求 `9e0400ff-7d40-4001-a3ef-53179c469c10` 在 `window2` 普通 IDE 后台执行。

只读核验读取了四次原生工具调用（两次搜索、两次 Read）。两个 71,305 字节文件的原始内容与工具返回逐字节一致，回复中的两个末尾验证词正确；没有写文件、运行终端或调用网络工具。压缩前快照有十条界面记录、十条当前提示消息引用、零个摘要归档，没有缺失引用。

已保存 `single-owner-before-compact.json`，请用户在同一会话执行 `/compact` 并暂不续聊，以便独立保存压缩阶段，之后再检查同后台续聊。该步骤是新的受控验证，不改变之前跨后台路径失败的结论。

### 手动命令的实际输入方式

用户输入 `/com` 时没有看到 `compact` 候选。已核对本机 3.24.12 的两个原生输入框提交处理：完整的 `/summarize` 和 `/compact` 都进入 `triggerManualSummarization`；判断是整行匹配，允许首尾空白并忽略大小写。短前缀 `/com` 不匹配，候选列表没有这项也不能证明命令不存在。

接下来的人工验证改用单独一行 `/summarize`，输入完整文本后直接发送，不等待候选、不附加说明，也不编辑先前的消息。[Cursor 3.19 发布说明](https://prod.cursor.com/docs/release-notes) 同样列出了这两个手动摘要入口。实际触发仍以原生 `preCompact(manual)` 与检查点变化为准；当前独立会话尚未观察到手动压缩事件。

### 独立会话的真实手动压缩已确认

用户发送 `/summarize` 后，在同一 `window2` 普通 IDE 后台执行 `summarizeAction`，执行 ID 为 `c88d44b1-6022-43c0-9231-98b39f175335`。原生 `preCompact` 为 `manual`，报告上下文 95,316 / 256,000 token，十条运行消息、八条待压缩消息、首次压缩。

| 阶段 | 界面记录 | 原生提示引用 | 摘要归档 | 完整历史工具结果 |
| --- | --- | --- | --- | --- |
| 独立会话压缩前 | 10 | 10 | 0 | 4/4 |
| `/summarize` 完成后 | 11 | 3 | 1 | 4/4 |

两份 71,305 字节的原始读取内容、四次工具结果与原有历史顺序保持完整，没有缺失引用。压缩前及压缩动作都来自同一普通 IDE 后台，尚未在另一个原生窗口执行这个新 ID。

已保存 `single-owner-after-summarize.json` 和 `single-owner-verification.json`。接下来等待同一会话的无工具续聊，检查新摘要是否保持、约定和两个验证词是否正确、实际对话输入量是否减少。压缩阶段成功还不等于续聊恢复或工作台联动验收通过。

### 同一后台的手动压缩后续聊：本条受控路径通过

用户已在同一会话完成无工具恢复问题。执行 ID 为 `df3446c6-f157-4002-8246-845f62a33bf8`，与读取和 `/summarize` 一样，均在 `window2` 的同一个 Agent Host 日志中执行，未在其他后台执行此原生 ID。当前摘要的 blob ID 和内容哈希与刚完成压缩时完全一致，没有回退到旧状态。

| 阶段 | 原生提示引用 | 摘要归档 | 完整历史工具结果 |
| --- | --- | --- | --- |
| 压缩前 | 10 | 0 | 4/4 |
| 手动压缩后 | 3 | 1 | 4/4 |
| 同后台续聊后 | 5 | 1 | 4/4 |

四项项目约定、两个文件末尾标记均回答正确；没有重新使用工具，原始历史顺序、四次工具结果及两份 71,305 字节读取内容均保持完整，没有缺失引用。`verifyCursorCompaction` 判定这条流程通过，另行核对当前摘要确实仍在当前提示消息中，而不仅保存在归档里。

原生 Hook 报告续聊 `input_tokens=12565`、`cache_read_tokens=3840`。压缩前的 `preCompact` 报告 `context_tokens=95316`。两个计数器含义不同，读取轮次还包含工具驱动的多次模型调用；这里不计算节省比例、不把缓存字段擅自相加，也不将其称为网络抓包结果或总费用。较小的续聊输入记录与摘要保持、当前提示引用数 3→5 一起支持本次压缩确实作用于后续执行。

证据为 `single-owner-after-recovery.json`、`single-owner-verification.json`、`single-owner-routing-proof.json` 和 `single-owner-token-evidence.json`。可用 `.test-data/cursor-single-owner-verdict.ts`、`.test-data/cursor-single-owner-routing-proof.cjs` 和 `.test-data/cursor-single-owner-token-audit.cjs` 重新核对；均不写 Cursor 数据库、不读取登录记录、不自动发送模型请求。运行顺序为判定脚本、路由证明、token 审计；判定脚本会重新生成报告，路由证明再补入后台证据。

此结果只覆盖本机 Cursor 3.24.12、Auto、普通 IDE、两个合成文件和一次手动压缩后续聊。此前跨后台恢复仍失败，不能用此结果覆盖。尚未覆盖退出整个 Cursor 进程后恢复、其他工具与子 Agent、授权和结构化提问，以及工作台双入口的互斥排队和实际传输。生产 Cursor 联动继续禁用。

实现依据得到进一步收敛：关联会话必须由同一个权威原生执行实例处理，历史读取、发送、手动压缩和状态提交确认都要对应这个实例。不能把普通 IDE 中验证通过的流程直接移植到当前只连接 Agents 页面和已加载文字的旧适配器，更不能让独立 CLI 继续另一份上下文。

### 完全退出后的原生恢复：本条跨版本路径通过

保存重启前快照和进程身份后，用户完全退出 Cursor，再在普通 IDE 打开「Cursor single owner validation」。所有旧的 Cursor 进程均不再运行，新进程创建时间都晚于基线；同一原生 ID 和原工作区保持不变。重启后安装版本为 **3.24.18**，重启前为 **3.24.12**。这是实际的跨版本恢复，不记为 3.24.12 同版本重启，也不由本次测试推断升级发生的原因。

加载后的检查点字节、当前提示消息、当前摘要、归档、历史正文和完整工具结果均与重启前一致。原生界面索引中的两个文本预览和一个高度提示发生变化；这些只是渲染元数据，单独记录，不用它们替代正文、顺序或工具内容的校验。

用户随后发送无工具恢复问题。执行 ID 为 `c091d4ec-25fc-4fe3-a797-8c5100267378`，在新的日志目录 `20261014T160319`、普通 IDE 的 `window1` Agent Host 中执行，并收到原生 `stop(completed)`。这不是只检查磁盘记录或加载画面，而是新进程的一次实际模型执行。

| 阶段 | 界面记录 | 当前提示引用 | 摘要归档 | 完整历史工具结果 |
| --- | --- | --- | --- | --- |
| 完全退出前 | 14 | 5 | 1 | 4/4 |
| 新进程加载后，未发送 | 14 | 5 | 1 | 4/4 |
| 新进程完成续聊后 | 17 | 7 | 1 | 4/4 |

续聊正确回答四项项目约定和两个末尾验证词，没有再次调用工具，没有新增压缩。当前摘要的 ID、内容保持一致；重启前全部历史正文及顺序仍在，四次工具结果和两份 71,305 字节原始读取内容完整，没有缺失引用。

证据位于 `.test-data/cursor-history-data-audit/`：`single-owner-before-process-restart-1014.json`、`single-owner-after-process-restart-before-send-1014.json`、`single-owner-after-restart-continuation-1014.json`、`single-owner-processes-before-restart-1014.json`、`single-owner-processes-after-restart-1014.json`、`single-owner-restart-verification-1014.json` 和 `single-owner-restart-routing-proof-1014.json`。先运行 `.test-data/cursor-single-owner-restart-verdict.ts`，再运行 `.test-data/cursor-single-owner-restart-route.cjs` 可重新核验并补入实际执行路由。这两个脚本均只读 Cursor 数据及选定测试日志，不发送请求、不写原生数据库。

验证器也补上了回归检查：如果压缩摘要只在归档中保留、当前提示已经换成另一个摘要，就判为状态恢复失败。当前提示的摘要必须实际一致，不能仅靠旧摘要仍能在本地找到判定通过。本次真实证据在收紧条件后仍通过，七个相关测试文件共 **60 个用例通过**，类型检查通过。

本条结果仍不是工作台联动验收。当前产品只读 Agents 观察通道尚未接入上述完整数据源，也没有完成固定权威后台的原生双入口拦截和提交确认。实际双端排队、手动摘要进入同一队列、授权与结构化提问、其他工具与子 Agent、后台崩溃及队列持久化仍需验证；生产联动限制保持。

### 3.24.18 的接入接口检查：尚未取得可用的外部权威通道

这轮检查没有修改安装文件、强开功能开关、装入扩展或启动另一个执行模型。只读安装代码与指定配置项得到：

- `composer.desktopBridge.sendMessage` 存在，但本机 `ItemTable` 的单项 `cursor.desktopBridge.enabled` 镜像为 `false`。这是缓存镜像，不是新的服务端功能授权查询。
- `extensionHostProcess.js` 中的 proposed API 校验明确将 `cursor`、`cursorAgentHost`、`cursorNoDeps` 等 API 限制为 `isBuiltin` 的扩展；普通外部扩展即使声明 API 或提供 `--enable-proposed-api`，仍会命中此限制。结论来自安装代码，没有实际安装外部扩展进行验证。
- Agent Host 安装代码中存在 `sendAction`、`enqueueOrStartAction` 以及队列管理接口。但这些内部方法的存在，不能作为工作台可连接当前原生实例的证据，也没有证明两端发送与手动摘要都会进入同一队列。
- 普通窗口控件操作与旧 Agents 观察通道仍有用途，但尚未证明能在完整原生提交之前拦截所有入口，并提供真实的状态提交确认。不能仅扩展窗口筛选或取消发送限制就开放双端联动。

已增加 `src/core/cursor-native-capabilities.ts` 和 `scripts/cursor-native-capability-audit.ts`，可重复读取安装版本、这两处源码的哈希及单项开关。未知源码形状、未知开关或缺失数据库都保持未确认。即使镜像为 enabled 或安装了发送命令，也不会把 `sharedSessionReady` 标为 true。诊断明确列出待验证的原生执行归属、两端入口、状态提交、对话与压缩队列；不读取 `ItemTable` 的其他值，不读取登录信息或调用令牌。

本机报告为 `.test-data/cursor-history-data-audit/capability-32418-1014.json`，安装版本 3.24.18，运行时扩展 API 为 builtin-only，Desktop Bridge 镜像 disabled。新增四个用例覆盖限制识别、开关与实际能力的区别、未知数据保持未确认，以及只读且不泄露凭据。

已为「Cursor single owner validation」保存 `single-owner-before-native-queue-1014.json`，请用户在第一条读取合成文件 3、4 的请求仍执行时提交第二条无工具回忆请求，并选择原生排队。观察脚本 `.test-data/cursor-native-queue-watch-1014.cjs` 只记录该原生 ID 的运行状态、请求编号、排队数量、历史条数及检查点哈希，不记录提示词或认证信息。首个 55 秒观察窗口只有既有空闲状态变化，尚未收到用户完成反馈，不能判为排队通过或失败。后续必须结合原生实际执行 ID、先后时间、完整历史及工具结果核验，仍不等于工作台双端排队验收。

### 使用 computer-use 的原生回车队列：排队及跨自动压缩续聊通过

用户要求由 computer-use 直接操作。实际只操作普通 IDE 的既有「Cursor single owner validation」会话；没有启动独立 CLI、修改原生数据库或安装文件。首次读取很快完成，第二条尚未提交，因此没有验证排队。后一次分段读取后点击发送按钮，同样未取得明确的等待队列证据。

最初根据第二次请求切换时的 `CancelledError`，暂时判断前一轮被提前中断。随后对照真正排队的路径发现，正常切到下一条请求时也会取消旧请求流。因此撤销“单凭该日志可证明取消未完成任务”的判断，按钮尝试只记为未取得排队证据，不据此断言该按钮在所有场景下都会打断任务。

在原生 Cursor Settings → Agents 只读确认：**New Messages = Queue**，**Manually Sent Messages from Queue = Interrupt**，**Submit with Ctrl + Enter = 关闭**。没有修改这些设置或权限。关掉本次打开的两个设置页并恢复布局后，改用原生 Return 键提交两轮测试。

第一轮使用新验证词 `CURSOR_QUEUE_ENTER_FIRST_1014`，按每次最多 64 行顺序完整读取合成文件 5、6；第二轮在第一轮尚执行时按 Return 提交无工具回忆问题。原生界面明确显示 **1 Queued Message**，队列项 ID 为 `dfd83444-64d7-4536-ac1d-9bf1ea6429cc`。该项只在等待托盘及原生 queueItems 中，不在正在执行的对话正文里。

| 本地时间（Asia/Shanghai） | 实际事件 |
| --- | --- |
| 17:28:03.430 | 第一轮在普通 IDE `window1` 的 Agent Host 执行，ID `1b446e75-b8a0-4eb0-8247-16ba2f67d888`。 |
| 17:28:55.805 | 只读观察首次取得同一队列项，当前执行 ID 仍为第一轮。 |
| 17:29:25.142 | 第一轮触发原生 `preCompact(auto)`，上下文 259,456 / 256,000 token，90 条运行消息、88 条待压缩；第二条仍在队列。 |
| 17:29:41.255 | 最后一次观察到第二条仍等待，第一轮的最后历史记录及检查点已经保存。 |
| 17:29:41.521 | 队列项自动取出，保存镜像转到第二轮；等待约 45.7 秒。 |
| 17:29:41.716 | 第二轮实际进入同一普通 IDE Agent Host，ID `ab23857c-5e27-4407-9d81-b07341d6e0c8`，未再次手动发送。 |
| 17:29:48.710 | 最后一轮收到原生 `stop(completed)`。 |

两轮在同一个原生 ID、同一个原工作区、同一个 Agent Host 日志中执行，每轮实际动作仅一次。第二轮没有在第一轮排队等待期间提前开始。第一轮的 18 次 Read 分别覆盖两份文件的 1–516 行，全部原始分段内容与对应文件逐段一致；没有写文件、运行终端或使用网络工具。第二轮正确回答新验证词及文件 5、6 的末尾标记，未新增工具调用。

| 阶段 | 界面历史记录 | 当前提示引用 | 摘要归档 | 完整历史工具结果 |
| --- | --- | --- | --- | --- |
| 此次回车验证前 | 71 | 55 | 1 | 26/26 |
| 队列及自动压缩后，两轮全部结束 | 116 | 19 | 2 | 44/44 |

原有全部历史正文与顺序保持，原有 26 次工具结果及四份较大的原始内容 blob 都完整；新增 18 次 Read 的调用 ID、参数、读取区间和结果均核对通过，没有缺失引用。导出过滤了系统角色消息，因此 JSON 的当前提示消息数分别为 54 和 18；表格使用原生检查点中的引用数，不将差值记为丢失用户或工具历史。第二条在自动压缩前加入队列，在压缩后正常执行，未由工作台拼接摘要或补入旧上下文。

证据：`single-owner-before-native-queue-enter-1014.json`、`single-owner-native-queue-enter-events-1014.jsonl`、`single-owner-after-native-queue-enter-1014.json`、`single-owner-native-queue-enter-verification-1014.json`。可运行 `.test-data/cursor-native-queue-enter-verdict-1014.cjs` 重查真实队列、原生日志、历史保留、分段读取内容和自动压缩事件。观察进程已经正常退出，没有留下持续后台任务。

还发现三个控制边界：

1. 实际运行时，保存镜像的 status 曾持续为 aborted，不能用该字段独立判断原生执行是否完成。
2. 原生切到下一条请求时会取消旧流；错误日志本身不能区分完成后的流清理与提前取消。需要结合任务结果、队列记录及检查点，而不是直接根据 CancelledError 释放锁或报告失败。
3. stop Hook 本次只记录最后一条请求，没有逐项提供第一轮的完成确认。它不足以作为工作台队列的每次状态提交凭证。

通过结论只适用于本机 3.24.18、普通 IDE、Auto 和原生 Return 队列路径。尚未接入工作台双入口，尚未得到产品传输所需的原生提交确认接口，也没有验证授权等待、用户主动中止、排队中的手动压缩、其他窗口或其他工具。因此原生排队可以作为后续接入的参考，但生产 Cursor 联动仍保持禁用。

### 2026-10-15：忙碌期间的手动摘要不会进入原生等待队列

继续在相同普通 IDE、同一个原生会话 `517b66f2-f11b-45a6-bc72-dd9b6780d7bb`、Auto 下验证。没有启动 CLI、修改安装代码或原生数据库。重新诊断仍为 Cursor 3.24.18，源码哈希与前一日相同，运行时扩展 API 为 builtin-only，Desktop Bridge 缓存镜像为 disabled。

第一次尝试在分段读取合成文件 1、2 时输入 `/summarize`，但点击提交时读取已经结束。这次只验证到空闲时摘要，不能算作忙碌时排队：当前提示引用 19→3，摘要归档 2→3，工具结果 44→62，历史正文、顺序和原有结果保留。

第二次先用原生 Read 顺序分段读取合成文件 3、4，每次 64 行，再在执行期间通过原生发送按钮提交 `/summarize`。界面及可访问性通知均明确显示：

> You cannot summarize while the agent is still working.

该命令被拒绝，没有出现等待项，也没有新增 `summarizeAction` 或 `preCompact`。当前读取没有被停止或改到其他后台，最终正确返回 `CURSOR_COMPACT_BUSY_1015` 和文件 3、4 的末尾标记。本次 18 次 Read 的参数、区间、原始内容均逐段匹配合成文件；全部历史工具结果增至 **80/80**，没有缺失引用。摘要归档仍为 3，当前摘要的完整原生记录与测试前一致。

| 本地时间（Asia/Shanghai） | 原生动作 |
| --- | --- |
| 09:24:12.606 | 第一次读取，`8a8bf622-90d9-4443-82a6-6ce86379b8e1`。 |
| 09:25:01.911 | 第一次读取结束后的摘要，`01d52780-a427-4145-8118-50f23597e7ab`。 |
| 09:28:34.077 | 忙碌期间摘要复测的读取，`bb784dc7-03b5-4c92-86d8-d88537a4e006`。 |

三个实际动作都位于同一个 `window1/exthost/anysphere.cursor-agent-host/Cursor Agent Host.log`。第二次读取期间的摘要命令没有生成第四个执行动作；这与原生“普通消息可以排队”是两个不同的结果。界面通知记录时间晚于实际显示时间，只作为观察证据，不把记录时间当作命令提交时间。观察器只运行限定时长，第二次的跟踪没有连续覆盖到最终提交，完成结果另用原生 stop、最终历史及工具结果交叉核对，不能将观察器最后一帧当成状态提交回执。

证据保存在 `.test-data/cursor-history-data-audit/`：

- `capability-followup-1015.json`：本机接口条件复查。
- `single-owner-before-compact-queue-1015.json`、`single-owner-after-compact-attempt-1015.json`、`single-owner-after-compact-busy-1015.json`：三个完整只读快照。
- `single-owner-compact-queue-events-1015.jsonl`、`single-owner-compact-busy-events-1015.jsonl`：两个有时限的只读观察记录，进程均已退出。
- `compact-busy-ui-observation-1015.json`：computer-use 观察到的原生通知。
- `native-followup-verification-1015.json`：执行路由、历史保留、36 段精确内容比较与忙碌时摘要被拒绝的复核结果。运行 `.test-data/cursor-native-followup-verdict-1015.cjs` 可重新核验。

产品设计由此补充一个明确条件：工作台不能把忙碌时的 `/summarize` 交给原生窗口后便显示“已排队”。必须先保留为未发送意图，等待权威后台确认上一轮状态提交完成，再执行同一会话的摘要，并提供取消等待的入口。现有队列原型的打桩验证覆盖 prompt→compact→prompt 顺序，但真实原生传输仍缺失，不能代替产品验收。

本轮重新运行 capabilities、compaction、history、mutation queue、turn lock、consistency、desktop client/service、native RPC 和 Codex shared runtime 共十个文件，**82 个用例通过**，`npm run typecheck` 通过。其中传输和队列包含打桩；实际原生证据仅覆盖本文限定路径。工具失败恢复的新增实测未发送成功：computer-use 输入在原生编辑器中未稳定落入草稿，不把操作尝试记为模型请求或测试通过，也没有改用独立 CLI 或写入数据库完成测试。

未完成项保持明确：工作台/原生双入口共用唯一执行者、跨入口并发与手动摘要等待、原生授权与结构化提问、工具失败与编辑/MCP/Skill、模型和权限切换、产品断线及队列崩溃恢复。这些项目需要接通真实原生后台后分别验收。当前联动仍禁用，未提交或推送本轮改动。

### 2026-10-15 后续：工具失败、主动停止、等待项取消与恢复

本轮继续使用相同原生 ID、普通 IDE、Auto 和既有合成测试文件。没有改写原生数据库、拼接另一份执行上下文或调用 CLI 替代原生执行。computer-use 的输入在明确选中占位文字后恢复；此前未成功落入草稿的操作仍保留为未发送，未把它们记作重复模型请求。

| 用例 | 原生实测结果 | 范围 |
| --- | --- | --- |
| Read 读取故意不存在的测试文件 | 仅调用一次，返回 File not found，模型随后正常完成回复。 | 覆盖原生 Read 失败及后续回复，不覆盖网络故障或外部命令失败。 |
| 自动压缩期间主动停止 | 原生收到 stop(aborted)，没有开始计划中的文件读取；检查点与停止前相同。 | 不能仅凭存储里的 aborted 字段判定停止，另核对了原生 Stop 操作、执行编号和 stop Hook。 |
| 上述停止后的续聊 | 保存了新的原生压缩状态，正确回答最近完成任务的验证词和先前读取失败的结果，没有新增工具调用。 | 续聊没有第二条 preCompact Hook，未确定是否复用了此前摘要计算；不将新摘要归因于另一条未观察到的计算请求。 |
| 分段读取期间主动停止 | 计划 132 次 Read，完成 78 次后停止：文件 1、2 各 33 次，文件 3 为 12 次，未开始文件 4。每段原始内容与文件逐段一致。 | 停止的是正在执行的整轮读取任务，未证明能够中断一个正在运行的外部命令或 MCP 服务调用。 |
| 主动停止时仍有等待请求 | 原生保留该等待项，停止后没有自动开始下一条。 | 与正常任务完成后自动出队不同。 |
| 取消停止后保留的等待项 | 仅取消本轮创建的测试等待项；没有生成相应用户/助手记录，模型当前提示和归档也没有该请求；历史及检查点不变。 | 覆盖已暂停等待项的取消，未覆盖取消与实际出队同时发生的原生竞争。 |
| 读取停止后的续聊 | 正确回答 CURSOR_WITHDRAW_OWNER_1015 和最后实际读取的 compaction-corpus-3.txt；没有继续读取。 | 同一个原生后台与原生会话，非工作台双入口联调。 |

最终读取到 **538 条原生历史记录、231 次完整工具结果（230 次成功、1 次失败）**，四份较大的原始读取 blob 保留，没有缺失引用。停止后取消等待项前后均为 535 条历史，检查点哈希不变；恢复追问后才新增三条原生记录。失败 Read 的原始工具结果、原生 output.error、isError 标记及 rawErrorMessages 在后续原生压缩及恢复后保持完整。

实际动作来自同一个 window1 的 Agent Host：

| 本地时间（Asia/Shanghai） | 执行编号与动作 |
| --- | --- |
| 09:58:02.964 | f55eacef-4ea4-46de-9f79-ad56fb65e89f，故意失败的 Read 及回复。 |
| 10:08:47.589 | cc6b9b94-1465-4c4a-b471-ebae54da2d21，进入自动压缩；10:09:01.059 收到 stop(aborted)。 |
| 10:11:59.572 | c0c393e1-5004-47a7-9713-a50260c58f84，停止后的续聊；10:12:05.836 收到 stop(completed)。 |
| 10:19:21.118 | ac8f1b43-cba6-43a6-a29c-7a320e7b4d99，16 行分段读取；10:22:56.192 收到 stop(aborted)。 |
| 10:27:35.549 | 6a8fdb48-283b-4098-82f7-c7092ec6c7b1，部分读取停止后的恢复追问；10:27:42.739 收到 stop(completed)。 |

用于最终取消验证的队列项为 4f7bf6af-1084-43d3-817b-2d3c815ddc3d，标记 CURSOR_QUEUE_WITHDRAW_FINAL_1015。只读观察器在 10:20:08.007 至 10:22:28.826 期间记录到该项，始终仍是原读取请求在执行。观察器因限定时长在真正停止前退出；停止后队列仍保留的事实来自 computer-use 截图及当时只读查询的 queueCount=1，不把有限跟踪伪装成覆盖全部操作的连续记录。最终取消后界面队列为空，等待项没有被写成已执行消息。

此前两次以取消为目的的尝试均未在任务完成前移除等待项，原生最终正常执行了测试消息；它们只是操作未赶上，不算取消通过或原生取消失败。最后一次明确完成了停止、保留等待项、取消等待项，再另发恢复追问。原生队列编辑栏的 Cancel 仅取消编辑，不移除等待请求，产品界面必须区分“取消编辑”和“取消等待”。

原生实测还暴露出两个原型问题，已修正并增加回归用例：

1. `cursor-desktop-history.ts` 原来只校验 status=completed 的工具，错误结果即使遗失也可能被漏检。现在 status=error 同样必须有对应原生工具结果。`cursor-compaction-verification.ts` 同时比较工具结果文字和原生 highLevelToolCallResult，错误信息或 isError 丢失也判为不完整。新增回归在修复前实际失败，修复后通过。
2. `cursor-native-mutation-queue.ts` 原来收到已提交的 aborted 结果后立即执行下一条，这与本机原生停止行为不同。现在进入 paused、保留等待项，只有明确 resume 才继续；暂停期间添加或取消等待项不会自动启动，resume 也不能绕过 uncertain 或未确认的状态。此为未接通传输的队列原型修正，不表示产品联动已经开启。整体运行错误的原生队列行为仍未验证，不将工具失败后正常完成的一轮当作整体执行错误。

另外核对了摘要的内容质量：最早四项项目约定仍在原始历史及旧归档中，但在 **09:25 的原生手动摘要**后已不在当前提示；本轮失败 Read 后模型回答 UNKNOWN。失败读取前后的当前摘要 ID 和内容完全一致，所以不能把遗忘归因于工具失败。此前“同一摘要在续聊和重启后保持”的通过记录仍有效；它不代表后续每次新的原生摘要都会保留所有旧约定。原始历史完整、摘要在恢复后保持、摘要内容是否足够，应分别验收。

可复核证据位于 `.test-data/cursor-history-data-audit/`：

- 工具失败：single-owner-before-error-stop-1015.json、single-owner-after-tool-error-rechecked-1015.json。
- 自动压缩停止及恢复：single-owner-after-stop-attempt-ran-to-completion-1015.json、single-owner-after-native-stop-1015.json、single-owner-post-stop-recovery-1015.json。
- 读取中止、取消等待及恢复：single-owner-before-withdraw-final-1015.json、single-owner-stopped-with-pending-1015.json、single-owner-after-withdraw-final-1015.json、single-owner-withdraw-recovery-completed-1015.json。
- 最终复核：native-error-stop-verification-1015.json；运行 `.test-data/cursor-error-stop-verdict-1015.cjs` 重查原生动作、历史顺序、失败结果、78 段读取内容、等待项未进入执行历史及恢复结果。

相关十个测试文件累计 **89 个用例通过**，类型检查通过。只读观察进程均正常退出，测试会话没有残留等待请求或执行中的测试任务。真实的工作台双入口、授权与结构化提问、模型/模式/权限切换、编辑/MCP/Skill，以及产品级断线和队列崩溃恢复仍待验收；此前原生进程重启恢复的通过结果不能替代这些项目。联动继续禁用。

### 2026-10-15 后续：提问尝试、模型地区错误与模式切换

继续使用同一普通 IDE、原生会话 517b66f2-f11b-45a6-bc72-dd9b6780d7bb 和合成工作目录，通过 computer-use 操作原生模式及模型菜单。没有调用 CLI 替代执行、写入原生数据库或注入替代摘要。

| 用例 | 结果 | 验收边界 |
| --- | --- | --- |
| 空闲时 Agent → Plan | 原会话保留；在 Plan 中执行了下一轮原生请求。 | 不是回复进行中的模式切换。 |
| Plan＋Auto 要求结构化单选题 | 原生显示普通文字选项 ALPHA_1015／BETA_1015，模型等待文字回复。 | 没有可点击卡片，没有原生 AskQuestion 调用，结构化提问仍未验证。模型自行进行 3 次 get_mcp_tools、1 次 Read 工具输出、1 次搜索，不能将这次尝试当作严格无读取测试或外部 MCP 调用通过。 |
| Plan 中 Auto → GPT-5.6 Sol | 原生返回 ERROR_UNSUPPORTED_REGION，标题 Model not available，isRetryable=false。 | 模型不可用是实际失败，不能记录成成功的跨模型续聊；未修改账号或地区设置。 |
| 切回 Auto 后续聊 | 正确回答 BETA_1015、compaction-corpus-3.txt、CURSOR_MODEL_RECOVERY_DONE_1015，无新增工具。 | 同一原生 ID、同一 window1 的 Agent Host，新增恢复请求来自明确操作，没有自动重发失败请求。 |
| 空闲时切回 Agent，再选 Grok 4.7 | 正确回忆前面的选择与最后实际读取文件，结束标记 CURSOR_MODEL_MODE_DONE_1015，无新增工具。 | 覆盖空闲时设置变化后的续聊，不证明运行中切换或工作台发起切换已接通。 |

四次实际原生动作均为同一宿主的 userMessageAction：

| 本地时间（Asia/Shanghai） | 原生执行编号 | 结束状态 |
| --- | --- | --- |
| 10:44:38.770 | dfbfd449-90db-41c0-9f4c-e071ebce7546 | completed，普通文字提问。 |
| 10:47:41.530 | b1b74343-8b48-4ac7-8e98-b943cc96cf8c | error，模型地区不可用。 |
| 10:49:51.710 | c72e772b-9c42-44d2-87ce-2d09e98b541d | completed，切回 Auto 后恢复。 |
| 10:53:31.867 | 9960db85-00cf-45ea-ae2c-f1a02ace86a6 | completed，Agent＋Grok 4.7 续聊。 |

地区错误发生后，原生根记录 status=aborted，但对应 stop Hook 的 status=error。这再次说明不能只读根 status 区分人工停止、模型失败及队列是否可继续。本次失败时没有等待请求，**原生整体错误后的队列行为仍未验收**。

实际错误数据位于失败助手消息的 errorDetails，含标题、原始错误、消息、请求编号、错误码及是否可重试；用户消息保留 modelInfo 和 agentMode。实验读取器原来未选择这些字段，导致导出的失败助手消息看起来为空。现已补齐白名单，并增加压缩校验及回归：失败原因、每轮模型或模式遗失时不能宣称历史完整。只读范围不扩大到登录记录或根密钥。新字段仅在新的只读导出中核对，旧证据文件未被修改或补造。

还观察到一项原生历史更新：恢复时，失败用户消息 8cb0ffc9-6985-4ca1-9826-ffeba0a76b43 的 createdAt 从 10:47:41.113 改为 10:49:52.216；其 ID、正文和顺序保持，失败助手错误记录仍在。这是原生记录的更新，不能宣称所有历史字段逐字节不变；未来同步应按原生消息 ID 接受权威字段更新，不用创建时间猜测新消息或重复执行。

最终为 **559 条原生记录、236 次完整工具结果**，此前失败 Read 结果与四份大内容 blob 完整，原生摘要与本轮开始前一致，没有缺失引用。仅在提问尝试中新增五次工具发现/输出搜索；模型失败及两次续聊没有增加工具。测试结束还原为 Agent＋Auto，输入为空，没有排队项和运行中的测试任务。

观察通道另外补了两个确定性回归：并发 snapshot 共用未完成的请求，防止慢旧响应覆盖新状态；关闭期间取消未完成的 HTTP 观察，迟到结果不能发布连接成功或重新创建轮询。关闭观察不向原生发送 Stop。新增回归均在修复前实际失败、修复后通过。相关十个测试文件累计 **93 个用例通过**。

本轮检查时仓库 HEAD 已为 c79fd83，成员提问等另有并行变更；全仓 npm run typecheck 最初被 src/renderer/team-questions.tsx 两处 answerId 类型错误阻断，最终复查已通过。此前 89 用例阶段的结果与本次最终检查分别记录；没有回退另一组变更或将它们一并提交。

证据位于 .test-data/cursor-history-data-audit/：single-owner-before-question-model-1015.json、single-owner-question-text-fallback-1015.json、single-owner-model-region-error-1015.json、single-owner-model-error-recovered-1015.json、single-owner-model-mode-rechecked-1015.json；运行 .test-data/cursor-question-model-verdict-1015.cjs 可复核，结果为 native-question-model-verification-1015.json。记录明确保留文字提问、地区失败、原生时间字段更新与真正通过的续聊范围，不把它们合并成双端联动通过。

仍待验收：真实工作台/原生双入口与唯一执行者、运行中模型/模式变化、原生提问卡片及授权、编辑/MCP/Skill、产品断线和队列崩溃恢复。此处记录的是本阶段结束时的禁用状态；后续产品接入结果见下一节。

### 2026-10-15 后续：文件中介接入真实工作台链路

本节更新前面各阶段的状态：普通 IDE 的原生联动已接入 Beta；旧 Agents Window 关联继续只读，独立 CLI 会话不变。未开启或绕过 Cursor 的私有 Desktop Bridge 开关，也没有改写安装文件或原生历史数据库。

文件中介保存待发送请求、幂等编号、顺序及暂停状态。实际发送由工作台把请求交给已核对身份的普通 IDE 原生输入框；Cursor 原有的 Agent Host 执行模型、工具及压缩。工作台通过只读数据库快照展示完整历史，不把显示出来的文本重新交给另一个 CLI 模型。它不是两个独立执行者之间复制对话。

真实联调使用既有原生会话 517b66f2-f11b-45a6-bc72-dd9b6780d7bb、合成工作目录和当前个人 Cursor 账号；没有连接共享区服务器。验证分成文件桥接原型和实际 Workbench 类接入两步。后一步使用生产 CursorFileService、CursorNativeRpc、Workbench.send/stop 和生产界面组件，运行于独立本地测试窗口；没有把这个组件测试宿主描述成完整主界面的端到端验收。

| 验证 | 实际结果 |
| --- | --- |
| 文件队列请求进入原生会话 | 原生返回正确验证词；保存了原生消息 ID，完整工具历史可读，无 CLI 替代执行。 |
| 原生端接续工作台消息 | 正确引用工作台前一轮的验证词及文件末尾标记。 |
| 工具运行时追加第二条工作台消息 | 首轮按 64 行分段读取完成后再执行第二条，后续模型能引用刚完成任务的内容。 |
| 生产 Workbench.send 入口 | 绕过 CLI 登录检查、项目上下文拼接和独立 AgentRuntime.prompt；原生保存的用户正文与实际提交一致。 |
| 原生 /summarize 后重启工作台并续聊 | 原生模型提示从 151 条减少到 3 条（导出排除 system 后为 150→2）；同一原生摘要保持，254 次原始工具结果和四份大内容文件保留。verifyCursorCompaction 所有项目通过。 |
| 工作台停止原生工具任务 | 计划 68 次 32 行 Read，实际 30 次后停止；原生 Stop Hook 记录 aborted，未继续剩余读取。 |
| 停止时保留第二条工作台请求 | 等待队列暂停，后续请求仍为 queued，未进入原生历史。 |
| 重启工作台后取消上述等待项 | 生产取消按钮把请求变为 cancelled；679 条原生消息 ID 及检查点均不变。被取消的验证词没有出现在原生用户消息中。 |

修复并回归的具体问题包括：原生根记录短暂为 aborted 时误判整轮停止、原生按钮采用 data-stop-button 导致找不到 Stop、停止后销毁观察器而收不到后续消息、原生摘要期间错误释放下一条、丢失 HTTP 回执时可能重发、取消早于迟到 enqueue 时没有撤销记录、旧同文消息被误认成送达，以及新进程恢复原会话尚未加载时过早报错。未确认送达时暂停并要求核对；不会凭匹配文字或超时自动重发。

本轮文件证据位于 .test-data/cursor-file-bridge-1015/：after-queued-send.json、after-native-continuation.json、before-product-summary.json、product-compacted.json、product-after-summary-resume.json、product-compaction-verdict.json、product-after-stop.json、product-after-withdraw.json 及 product-data/sessions.json。check-compaction.ts 可复核真实原生压缩前后及工作台重启后的状态。

验收范围仍有限：完整 Cursor 进程退出后由工作台重新打开的产品路径，正在等待原生关闭确认；不能用此前原生单端重启结果替代。运行中模型/权限变化、原生授权与结构化提问卡片、编辑/MCP/Skill 组合、真实崩溃及故障注入也未在新产品路径逐项验证。相关窗口定位、单次发送、身份不匹配、丢失回执、恢复、队列撤销等已有隔离回归，但打桩不记作这些原生组合通过。

### 2026-10-15 后续：原生运行中追加工作台消息，跨自动压缩出队

原生关闭提示尚未获确认，因此先取消退出，继续不依赖退出操作的真实验证。再次通过正常窗口操作重启本地工作台测试宿主，确认原生 679 条历史和暂停状态恢复；明确恢复空队列后，在原生窗口发起六份合成文件的完整读取任务，再从工作台发送等待追问。

| 本地时间（Asia/Shanghai） | 实际动作 |
| --- | --- |
| 13:39:05.066 | window1 的 Agent Host 接收原生 userMessageAction，执行编号 74a83b3d-2a48-4770-aba4-27b28007ec82。 |
| 13:40:13.061 | 工作台请求 2ca6eda9-c898-4609-93c7-40b540ed5ed9 进入文件队列，状态 queued；未进入原生历史。 |
| 13:40:15.859 | 同一执行编号触发 preCompact(auto)，102 条提示中 99 条参与原生压缩，归档数由 6 增至 7。 |
| 13:41:10.309 | 原生读取任务 stop(completed)，返回验证词和六个末尾标记。 |
| 13:41:11.267 | 同一 window1 的 Agent Host 接收工作台消息，执行编号 8c49bb7f-03e5-4972-8d10-8d9d8b7b72de；原生用户消息落盘时间为 13:41:11.500。 |
| 13:41:18.227 | 工作台这轮 stop(completed)，六个标记和 CURSOR_CROSS_ENTRY_QUEUE_DONE_1015 均正确，文件请求为 completed。 |

最终两端按相同原生消息 ID 和顺序保持 **748 条完整历史、311 次工具结果、四份大内容文件**，没有缺失引用，取消过的旧请求仍未进入原生历史。压缩后的同一份原生摘要同时存在于运行中快照和最终续聊的当前模型提示，旧工具结果及内容保留检查通过。没有重灌旧历史来补答，也没有并行 CLI 执行。

注意校验范围：自动压缩发生于原生任务内部，压缩前及过程中采到的两个真实快照本来就 unsettled；静态三快照校验器的 allSettled=false、result=unverified 如实保留，未伪造为静止状态。自动触发事实由同一执行编号的原生 Hook 确认，队列等待、后续执行时间、摘要保留、消息顺序、原始工具及内容保留由 check-cross-entry.ts 分项断言验证。它不是完整进程重启恢复的通过记录。

新证据：product-before-cross-entry-auto.json、product-cross-entry-auto-queued.json、product-cross-entry-after-auto.json、product-cross-entry-completed.json、product-cross-entry-verdict.json。本轮隔离组件、协议和生命周期回归 **125 项通过**；原生 DOM 定位、队列 UI 和既有导入 UI 三项独立 smoke 检查通过，类型检查与构建通过。

另行执行的全仓后台回归为 646 项，629 项通过、17 项未通过，失败涉及成果整理预期、MCP 发现及进程测试的后台限制；未记为全仓通过。检查期间仓库 HEAD 从 c79fd83 变为 0f359ca，保留并行变更，未回退或一并提交。完整 Cursor 退出重开验证仍待关闭确认。

### 2026-10-15 后续：完整 Cursor 进程退出及工作台重开恢复

用户确认允许关闭后，正常点击原生 Close 确认，两次分别在本地 14:12:00 和 14:19:12 核对 Cursor.exe 进程集合为空。均由工作台的“在 Cursor 中打开 · Beta”重新启动普通 IDE；未手工新建替代会话、未改写历史数据库，也未回退 CLI。原生仍关联 517b66f2-f11b-45a6-bc72-dd9b6780d7bb。

第一轮完整退出后，原检查点及当前模型提示逐项相同，748 条历史、311 次工具结果和四份大内容文件均保留。工作台追问正确回答六份文件末尾标记及原读取验证词，历史变为 751 条，请求只送达一次。

本轮发现并修复一个真实恢复问题：普通 Git 通知带有 role=dialog，被适配器误认为阻塞确认，导致请求留在 queued，直到通知自行消失。该通知无需用户作决定便能继续原生聊天。修复将 notifications-toasts、notifications-center 及 notification-toast-container 中的非模态通知与实际模态确认区分；显式 aria-modal=true 的对话框仍阻止发送。新增隔离 DOM 回归在修复前实际失败，修复后通过。

加载修复后，第二次完全退出 Cursor，再从同一个工作台测试进程重开。在 Git 通知仍可见时发送工作台追问，已正常进入原生 Agent 并完成，正确引用第一轮恢复回复的标记及六文件读取的验证词，无需关闭通知或改变 Git 设置。第二次重开时，751 条历史和原检查点保持；完成后两端为 **754 条历史、311 次工具结果、7 份原生摘要归档**，没有新增工具调用、缺失引用、重复请求或残留等待项。

对比时还发现，Cursor 在恢复后更新了七条消息的 header 展示缓存；其余白名单消息字段、正文、思考、工具信息、原始结果、内容文件、当前模型提示和检查点分别校验保持。因此验收的是完整语义和执行状态保留，不声称整个数据库逐字节不变。

证据位于 .test-data/cursor-file-bridge-1015/：product-cursor-exited.json、product-after-cursor-reopen.json、product-after-restart-continuation.json、product-cursor-exited-fixed.json、product-after-cursor-reopen-fixed.json、product-after-restart-fixed-continuation.json、product-cursor-restored-fixed.json。运行 check-restart.ts 得到 product-restart-verdict.json，result=passed。两轮模型执行分别为 7be761fb-0647-4dbc-a468-c57dcc7f67f9 和 91fa0913-a85f-4854-abc4-342d86f15190，原生 Stop Hook 均为 completed。

此前“等待关闭确认”的状态已由本节的实际验证取代。普通 IDE 的已有原生会话现在已覆盖真实双入口续聊、工作台排队、停止及取消、手动和自动压缩后的续聊、工作台重启、完整 Cursor 进程退出重开后的恢复。独立 Agents Window、原生提问/授权卡片代办、原生新会话创建及模型/MCP/Skill 设置仍遵循使用说明中的界限，未将其扩写为全部桌面功能一致。

### 2026-10-15 后续：正式用户端入口验收与回归修复

从原有 start-user-dev.cmd 启动正式用户端，使用独立本地文件共享桩及账号 beta_alice，未连接共享区服务器。原生 Cursor 先正常退出，随后从正式“接入 Cursor 会话”窗口的“打开 Cursor 并读取会话”启动。原生窗口初次恢复聊天有延迟；刷新后可以选择 Cursor single owner validation。空列表提示现已给出打开聊天和刷新的明确操作，连接错误中的按钮名与本窗口对齐。

正式 UI 开启 Cursor Beta，导入同一原生 ID，再从工作台发送 FORMAL_UI_A_1015；正确引用此前压缩、完整 Cursor 退出重开后的记录。从原生端续聊正确回答 FORMAL_UI_A_1015，工作台自动收到该轮。正常退出工作台后，再用同一旧脚本启动：原生关联、760 条历史及账号级 Beta 开关恢复，后续工作台消息正确引用原生端最后一轮，最终 763 条历史的 ID、顺序和正文与只读原生数据库逐条相同，311 次工具结果、四份大内容文件和七份原生摘要归档完整。两个工作台提交各自只有一个对应原生消息，队列无残留等待或未确认请求。证据：.test-data/formal-cursor-beta-1015/verdict.json；verify.ts 可读取当前打桩数据重复检查，formal-native-snapshot.json 保存验收快照。

回归定位到两个产品兼容问题：账号级设置 schema 漏掉 cursorDesktopSync，导致重启丢失开关；旧分类成果与新项目概况共用 contract=4，导致旧草稿被误认为新格式。现补齐 Beta schema，为新项目概况增加 organizationFormat=project-profile-v1；旧分类草稿保持原格式，早期项目概况由完整字段或原整理提示词识别。迁移、重试、空结果确认、旧分类草稿上传/合并/权限均有回归覆盖。已有测试夹具按当前格式补齐显式标记；MCP 与插件分开展示的已有行为保留独立覆盖。Windows 进程身份验证测试移入 test:desktop，后台防启动约束保持不变；该两项在实际 Windows 单独通过。

初次完整回归曾与启动器因依赖清单变化执行的 npm ci 重叠，依赖被替换期间出现模块缺失；该轮不作为产品失败或通过依据。依赖稳定后的完整回归及最终提交验证以当前日志为准。

最终 v0.7.1 提交验证：完整后台回归 647/647 通过，无跳过；类型检查、正式构建及隔离构建通过，用户版/管理版产物版本与源码和锁文件一致。三项隔离 UI smoke 通过。当前产品状态及命令见仓库 VERIFICATION.md 顶部；本机日志 final-regression.log 未纳入 Git。
