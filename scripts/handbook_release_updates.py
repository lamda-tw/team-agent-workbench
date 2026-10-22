"""Apply current product guidance to HTML inputs while keeping other formats intact."""
import re
from handbook_network_guidance import network_guidance
from handbook_product_guidance import product_guidance
from handbook_current_guidance import current_guidance


def replace_section(source, anchor, next_anchor, body):
    pattern = r'(<a id="' + re.escape(anchor) + r'"></a>\s*\n### [^\n]+\n).*?(?=<a id="' + re.escape(next_anchor) + r'"></a>)'
    # Related reference documents do not contain the user-guide anchors.
    if f'<a id="{anchor}"></a>' not in source:
        return source
    result, count = re.subn(pattern, lambda match: match[1] + '\n' + body.strip() + '\n\n', source, flags=re.S)
    if count != 1:
        raise ValueError(f'Handbook section changed: {anchor}')
    return result


def release_updates(source):
    source = source.replace('## 6 整理并上传工作成果', '## 6 整理成果并选择保存位置')
    source = source.replace('保存新成果后，原成果才移入历史；生成预览不会改变原成果。', '处理完成先生成可审阅的草稿；仅在确认保存时，勾选的来源才会移入历史。')
    source = source.replace('**删除整理记录**会在运行中停止该次整理，并从列表移除记录；已保存或已上传的记录也可删除。删除不会连带删除本地成果、团队成果、原 Session、已有引用、上传传输记录或该会话的增量进度。', '**删除整理记录**会在运行中停止该次整理，并从列表移除记录；尚未保存或提交的草稿内容也会删除。已保存的个人成果、已提交的团队成果、原 Session、已有引用、上传传输记录及增量进度保留。')
    source = source.replace('**完成标志：**团队项目成果库中可查看对应结果，传输记录显示已完成。整理完成不代表团队已经收到成果。', '提交团队后，在传输记录核对状态；上传完成的成果可从**项目成果库 → 团队**查看。只保存到个人库的成果不会出现在团队页。')
    source = source.replace('本机可直接访问模型服务时，不启用**通过管理端访问模型服务**。',
        '新建会话使用本机网络时，保持**通过管理端访问模型服务**关闭。')
    source = source.replace('**本地项目成果库**', '**项目成果库 → 个人**').replace('**团队项目成果库**', '**项目成果库 → 团队**')
    source = source.replace('团队页默认仅展示与当前账号个人库有差异的成果；',
        '在左侧打开**项目成果库**，选择**团队**页。成果以卡片显示，标题下方提供类别、作者、更新时间和正文预览；点击标题展开详情。团队页默认仅展示与当前账号个人库有差异的成果；')
    source = replace_section(source, 'section-4-1', 'section-4-2', '''
1. 选择项目，点击**新建会话**。
2. 选择 **Codex**、**Cursor** 或 **Claude Code**。
3. 在**网络连接**中选择本次会话的路径：本机直连、直连管理端，或经共享服务器中转。使用管理端时勾选**通过管理端访问模型服务**，粘贴总管理员提供的接入码，点击**应用并重新检测**。三种路径的界面操作见[创建工作会话](#case-session-routes)。
4. 查看所选工具的账号状态。显示**未登录**时，点击**登录个人账号**并完成授权；完成后点击**重新检测**。显示**已登录**时，核对账号名称。提示检测失败时，按[检查 CLI 程序与模型账号](#cli-account-check)排查。
5. 选择模型和执行权限，核对工作目录，再点击**创建会话**。会话使用项目已记住的代码目录；项目未设置目录时，工作台为会话创建独立、持久的调研目录。
6. 输入目标、参考资料、期望产出和验收要求。按 **Enter** 发送，按 **Shift+Enter** 换行。
7. 阅读回复并检查实际产物。出现待批准操作时，核对具体操作后选择允许或拒绝。

注：网络路径只应用于这次新建的会话，其他会话继续使用各自的路径。更换管理端接入信息前，先结束或停止正在使用管理端出口的任务。

**任务示例：**“请比较两种转换路径。先验证正确性，再记录设备、输入规模和耗时波动；输出比较表与未验证项。”

模型和额度按 CLI 返回的信息显示。Claude Code 的套餐额度可通过官方额度页查看。

<a id="cli-account-check"></a>

### 检查 CLI 程序与模型账号

操作入口：用户版 **设置 → 本机与 CLI**。

1. 找到要使用的 Codex、Cursor 或 Claude Code。将 **CLI 程序路径**留空，点击**保存并检测 CLI**。
2. 查看检测到的程序路径和版本。工作台优先查找系统 PATH 中的 CLI，再查找内置版本、项目依赖和常见安装目录。已手动填写路径时，使用指定的程序。
3. 在 CMD 执行下表对应命令，核对日常使用的 CLI 入口。Windows 下选择 `.exe` 或 `.cmd` 文件；同目录的无扩展名文件通常是其他系统使用的启动脚本。
4. 需要指定版本时，将对应的 `.exe` 或 `.cmd` 路径填入 **CLI 程序路径**，再次点击**保存并检测 CLI**。
5. 返回新建会话的**网络连接**，确认连接方式，查看对应工具的账号状态。

| 工具 | CMD 中查找程序 | CMD 中查看版本 |
| --- | --- | --- |
| Codex | `where codex` | `codex --version` |
| Cursor Agent | `where agent`；使用 cursor-agent 入口时执行 `where cursor-agent` | `agent --version` 或 `cursor-agent --version` |
| Claude Code | `where claude` | `claude --version` |

注：Cursor 使用 Agent CLI；`cursor` 是编辑器入口。刚安装 CLI 或修改系统 PATH 后，关闭工作台及原启动终端，再重新打开工作台，让新进程读取更新后的环境变量。

| 显示状态 | 接下来怎么做 |
| --- | --- |
| 未找到 CLI | 安装对应 CLI，或在设置中选择已安装的程序，再保存并检测。 |
| 检测失败 | 阅读具体提示。路径或版本提示按上面的步骤核对；网络提示先检查当前网络或管理端出口，再重新检测。 |
| 未登录 | 点击“登录个人账号”，在打开的授权页面完成登录，再重新检测。 |
| 已登录 | 核对账号名称，再选择模型并创建会话。 |
| 凭据已配置／无需 OpenAI 登录 | 工作台沿用 CLI 已配置的认证方式；按对应服务的配置继续使用。 |

CMD 能打开 CLI，说明该入口可以启动。工作台还会检查账号状态，并通过所选网络读取模型信息。记录失败提示、CLI 路径和版本，可用于定位具体环节。
''')
    source = source.replace('| CLI 未登录 | 完成所选提供方登录后重新检测 |',
        '| CMD 可打开 CLI，工作台检测失败 | 先按[检查 CLI 程序与模型账号](#cli-account-check)核对程序路径和版本，再根据提示检查账号或网络。 |\n'
        '| CLI 未登录 | 点击“登录个人账号”，完成授权后重新检测。 |')
    source = source.replace('各窗口分别保存连接、会话、草稿和传输记录。',
        '各窗口分别保存连接、会话、草稿和传输记录。同一窗口切换成员账号后，只显示当前账号的本地会话、输入草稿、个人成果和传输记录；原账号的数据保留，切回后可继续使用。')
    source = product_guidance(network_guidance(source))
    if source.startswith('# 项目组与角色'):
        source = source.replace('系统管理员', '总管理员').replace('最初创建人的历史记录不变', '创建记录保留')
    source = source.replace('详见[会话相关动态提醒](activity-recommendations.md)。', '候选条目会说明关联理由并显示原文片段；发送前核对需要加入会话或保存个人库的内容。')
    source = source.replace('详见[桌面联动使用与验证记录](codex-desktop-sync.md#在现有工作台中使用)。', '设置和使用范围见[Beta 功能](#beta-features)。')
    return current_guidance(source)
