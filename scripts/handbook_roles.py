"""Use one set of workbench role names in the HTML handbook.

The source Markdown also feeds older Word/PDF builds. Keep this editorial pass
limited to the HTML build and preserve labels printed in the current UI.
"""

import re


ROLE_TABLE = """| 身份 | 使用入口 | 主要职责 |
| --- | --- | --- |
| 总管理员 | 管理员版 | 连接和初始化团队服务器，开通与停用账号，全局管理项目组与回收站，查看共享空间，配置管理端网络出口 |
| 项目组管理员 | 用户版 | 创建项目、维护项目说明、派发并验收任务、管理团队成果；组内的创建者另可管理成员、任命管理者、移交创建者和删除组 |
| 项目组成员 | 用户版 | 开展会话、接收任务、上传自己的成果、阅读和采用团队资料 |

同一团队账号可在不同组担任不同角色；项目组管理员也可完成项目组成员的个人工作。所有已启用用户都能在用户版自行创建项目组，创建后登记为该组的创建者。

界面中的**创建者**和**管理者**都具有项目组管理员的内容管理能力。创建者每组一位，还负责组成员和权限；管理者可有多位，负责项目与成果。界面中的**成员**对应项目组成员。总管理员连接 Linux 服务器时使用已有的 root 或 sudo 管理权限。项目组操作见[项目组与权限](#group-permissions)。"""


def normalize_roles(source: str) -> str:
    """Normalize role references while leaving quoted controls and code intact."""
    source = source.replace(
        '本手册面向普通成员、项目组管理员和总管理员。',
        '本手册面向总管理员、项目组管理员和项目组成员。',
    )
    old_table = re.compile(
        r'\| 身份 \| 使用入口 \| 主要职责 \|\n'
        r'\| --- \| --- \| --- \|\n'
        r'\| 普通成员 .*?(?=<a id="section-1-2"></a>)',
        re.S,
    )
    source, count = old_table.subn(ROLE_TABLE + '\n\n', source, count=1)
    if '<a id="section-1-1"></a>' in source and count != 1:
        raise ValueError('Role overview changed; update HTML role normalization')

    exact = {
        'root 是 Linux 系统管理员账号': 'root 是 Linux 的高权限账号',
        'Windows 管理员身份不能替代 Linux 管理权限': 'Windows 本机提权不能替代 Linux 服务器管理权限',
        '这些动作需要系统管理员权限': '这些动作需要 Windows 系统提权',
        '管理员先确认管理端网络': '总管理员先确认管理端网络',
        '管理员提供的': '总管理员提供的',
        '管理员处取得': '总管理员处取得',
        '管理员电脑': '总管理员的设备',
        '管理员可在管理员版开启': '总管理员可在管理员版开启',
        'Electron 界面验证管理员': 'Electron 界面验证总管理员',
        '管理员分发指纹': '总管理员分发指纹',
        '管理员配置文件': '管理员版配置文件',
        '管理员界面': '管理员版界面',
        '管理员环境': '管理员版环境',
        '管理员进程': '管理员版进程',
        '管理员变更': '总管理员变更',
        '完整管理员安装': '完整的管理员版部署',
        '当前组管理员访问策略': '当前项目组管理员访问策略',
        '管理员准备上传通路': '总管理员准备上传通路',
        '管理员更新接入码后': '总管理员更新接入码后',
        '管理员首次启用中转后': '总管理员首次启用中转后',
        '管理员指定的共享服务器': '总管理员指定的共享服务器',
        '管理员怎么做': '总管理员怎么做',
        '团队账号**是管理员分配': '团队账号**是总管理员分配',
        '**模型账号**是成员自己的 Codex 或 Cursor 账号': '**模型账号**是项目组管理员和项目组成员各自使用的 Codex、Cursor 或 Claude Code 账号',
        '**成员 A、B**': '**项目组成员 A、B**',
        '项目组管理员和成员访问团队项目': '项目组管理员和项目组成员访问团队项目',
        '项目组管理员和成员采用相同的接入方式': '项目组管理员和项目组成员采用相同的接入方式',
        '任务附件仅负责人及本组项目组管理员可读': '任务附件仅负责人及该组项目组管理员可读',
        '成员 A 在本机开会话': '项目组成员 A 在本机开会话',
        '接入管理员提供的网络': '接入总管理员提供的网络',
        '联系管理员检查目录权限': '联系总管理员检查目录权限',
        '交给管理员检查目录权限': '交给总管理员检查目录权限',
        '向维护人员核实后': '向总管理员核实后',
        '模拟管理员可免密码进入': '本地模拟模式可免密码进入管理员版',
        '正式服务器仍验证管理员身份': '正式服务器仍验证总管理员的服务器管理权限',
        '供管理员检查其他管理员派发的工作': '供项目组管理员检查其他项目组管理员派发的工作',
        '管理员可恢复，恢复后仍是': '项目组管理员可恢复，恢复后仍是',
        '管理员与成员均可筛选': '项目组管理员和项目组成员均可筛选',
        '需要管理员先处理': '需要总管理员先处理',
        '由管理员手动刷新': '由总管理员手动刷新',
        '管理员可以取消正在运行的统计': '总管理员可以取消正在运行的统计',
        '管理员进程使用 lstat': '管理员版进程使用 lstat',
        '管理员使用 `WORKBENCH_ADMIN_DATA_DIR`': '管理员版使用 `WORKBENCH_ADMIN_DATA_DIR`',
        '管理员维护、合并/移除': '项目组管理员维护、合并/移除',
        '管理员恢复': '总管理员恢复',
        '多个管理员独立使用': '多台管理端独立使用',
        '禁用管理员不允许的选项': '禁用组织策略不允许的选项',
        '管理员约束': '组织策略约束',
        '借用管理员的模型账号': '使用总管理员的模型账号',
        '管理员调整组或角色后': '总管理员调整组或角色后',
        '联系管理员分配后': '联系总管理员分配后',
        '管理员分组后刷新': '总管理员分组后刷新',
        '联系管理员升级服务端功能': '联系总管理员升级服务端功能',
        '被管理员整理后': '被项目组管理员整理后',
        '被管理员接管的内容': '被项目组管理员接管的内容',
        '由管理员接管': '由项目组管理员接管',
        '管理员接管的内容': '项目组管理员接管的内容',
        '管理员保存操作': '项目组管理员保存操作',
        '需管理员先处理': '需总管理员先处理',
        '只有管理员在弹窗点击': '只有总管理员在弹窗点击',
        '管理员先自行将': '总管理员先自行将',
        '管理员创建用户时': '总管理员创建用户时',
        '管理员版创建首个成员用户时': '总管理员在管理员版创建首个项目组成员账号时',
        '管理员应使用服务器已经存在的': '总管理员应使用服务器已经存在的',
        '管理员须在现有启动流程中': '总管理员须在现有启动流程中',
        '管理员可以取消正在运行的统计': '总管理员可以取消正在运行的统计',
        '管理员需要提供的信息': '总管理员需要提供的信息',
        '管理员首次开放中转后': '总管理员首次开放中转后',
        '管理员启用一次后': '总管理员启用一次后',
        '需管理员重新登录': '需总管理员重新登录',
        '请管理员确认显示': '请总管理员确认显示',
        '请管理员核对并重新提供': '请总管理员核对并重新提供',
    }
    for old, new in exact.items():
        source = source.replace(old, new)

    # Quoted strings, bold UI labels and code are copied from the application.
    protected = re.compile(r'`[^`]*`|\*\*[^*]*\*\*|“[^”]*”')

    def normalize_text(text: str) -> str:
        text = text.replace('成员 A 和 B', '项目组成员 A 和 B')
        text = re.sub(r'(?<!项目组)成员 A、成员 B', '项目组成员 A、项目组成员 B', text)
        text = re.sub(r'(?<!项目组)成员 A、B', '项目组成员 A、B', text)
        text = text.replace('项目子管理员', '项目组管理员').replace('子管理员', '项目组管理员')
        text = text.replace('本组普通成员', '项目组成员').replace('普通成员', '项目组成员')
        text = text.replace('本组组管理员', '项目组管理员')
        text = re.sub(r'(?<!项目)(?<!内容)组管理员', '项目组管理员', text)
        return text

    result = []
    fenced = False
    for line in source.splitlines(keepends=True):
        if line.lstrip().startswith('```'):
            fenced = not fenced
            result.append(line)
            continue
        if fenced:
            result.append(line.replace('项目子管理员', '项目组管理员').replace('子管理员', '项目组管理员'))
            continue
        position = 0
        pieces = []
        for match in protected.finditer(line):
            pieces.append(normalize_text(line[position:match.start()]))
            pieces.append(match.group())
            position = match.end()
        pieces.append(normalize_text(line[position:]))
        result.append(''.join(pieces))
    return ''.join(result)
