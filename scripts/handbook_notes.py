"""Render secondary guidance consistently in the HTML handbook."""
import html
from handbook_release_updates import release_updates
from handbook_roles import normalize_roles
from handbook_latest_guidance import latest_guidance


def render_notes(items, render=html.escape):
    if not items:
        return ''
    if len(items) > 1 and all(isinstance(item, str) and item.startswith('**') for item in items):
        points = ''.join('<li>' + render(item) + '</li>' for item in items)
        return '<aside class="doc-note doc-note-points" role="note" aria-label="补充说明"><strong class="doc-note-heading">注：</strong><ul>' + points + '</ul></aside>'
    paragraphs = ''.join('<p>' + ('<strong>注：</strong>' if i == 0 else '') + render(item) + '</p>' for i, item in enumerate(items))
    return '<aside class="doc-note" role="note" aria-label="补充说明">' + paragraphs + '</aside>'


def editorial_notes(source):
    source = release_updates(source)
    source = source.replace(
        '普通成员只能修订自己上传且尚未由组管理员接管整理的团队成果。组管理员可维护本组团队成果。已整理内容需要修改时，交由组管理员处理，或另行提交补充结论。',
        '项目组成员可修改或删除自己上传且尚未由项目组管理员修改的团队成果。项目组管理员在“项目成果库 → 团队”点击“更多 → 编辑成果”并“保存修改”后，该条共享成果改由项目组管理员维护；合并结果提交到团队后，仅勾选的来源移入合并历史。原作者需要更正这些团队版本时，向项目组管理员提供更正内容，或另行提交补充成果。',
    )
    source = source.replace(
        '成员原成果经组管理员整理后，不能继续覆盖该团队成果。新增证据可另发补充成果，或请组管理员更新。',
        '项目组管理员编辑并保存成员上传的团队成果后，原作者不能直接覆盖该共享版本。合并结果提交到团队后，仅勾选的来源移入合并历史；新增证据可另发补充成果，或请项目组管理员更新综合结果。',
    )
    source = source.replace(
        '普通成员仅可选择自己上传、且尚未由组管理员接管的内容。',
        '项目组成员仅可选择自己上传、且尚未由项目组管理员编辑保存的团队成果。',
    )
    source = source.replace(
        '**不能覆盖自己的旧成果：**检查是否已由组管理员整理。另交补充，或请组管理员修改。',
        '**不能覆盖自己上传的旧成果：**查看该团队成果是否已由项目组管理员编辑保存，或已并入综合结果。可提交补充成果，并请项目组管理员更正团队版本。',
    )
    source = source.replace(
        '普通成员只能选择自己尚未被组管理员整理的提交。',
        '项目组成员只能选择自己上传且尚未被项目组管理员编辑保存的提交。',
    )
    source = source.replace(
        '修改、替换、删除自己尚未由管理员接管的提交',
        '修改、替换、删除自己上传且尚未由项目组管理员编辑保存的提交',
    )
    source = source.replace(
        '修改管理员接管的内容',
        '修改已由项目组管理员编辑保存的团队成果',
    )
    source = source.replace(
        '组管理员修改后，该成果由管理员接管，原作者不能再改写或删除',
        '项目组管理员编辑并保存后，该成果改由项目组管理员维护，原作者不能再改写或删除',
    )
    source = source.replace('自动安装目前支持 Debian/Ubuntu 的 apt-get；', '此功能通过 apt-get 补装工作台缺少的软件组件，适用于已运行 Debian/Ubuntu 的服务器；')
    # These complete paragraphs explain behavior after the adjacent operation.
    # Prerequisites, required actions and acceptance criteria stay in the main text.
    prefixes = (
        '同项目可创建多个会话。',
        '批准请求只对应当前操作。',
        '发送失败时，待带入成果保留。',
        '**阶段摘要与成果说明不同。**',
        '入口保留当前窗口上次选择的范围，',
        '**不会自动加入所有会话。**',
        '第一位组成员默认成为组管理员，',
        '**代码仍通过 Git 协作。**',
        '依赖下载发生在应用启动前，',
        '下文的系统配置文件以服务器文件系统根目录为基准',
    )
    source = source.replace('更改组合只影响后续整理，不会给旧成果重新分类。', '\n\n注：更改组合只影响后续整理，不会给旧成果重新分类。')
    return latest_guidance(normalize_roles('\n'.join('注：' + line if line.startswith(prefixes) else line for line in source.split('\n'))))
