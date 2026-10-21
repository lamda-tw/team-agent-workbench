"""Read release metadata from the Markdown source of the user manual."""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs/user-guide.md'

# One manifest drives HTML topics, ZIP Markdown files, and incremental inputs.
RELATED = {
    'project-groups.md': ('group-permissions', '项目组与权限'),
    'deployment-guide.md': ('deployment', '部署指导'),
    'network-egress.md': ('egress-reference', '管理端网络出口说明'),
    'result-classification.md': ('classification-reference', '个人成果分类与任务入口'),
    'session-steering.md': ('steering-reference', '会话生成中的引导'),
    'shared-bulk-delete.md': ('bulk-delete-reference', '团队成果批量删除'),
    'preparation-lifecycle-audit.md': ('preparation-reference', '整理记录与增量进度'),
    'background-testing.md': ('background-reference', '不干扰日常使用的验证方式'),
    'workflow-states.md': ('workflow-reference', '工作流状态与操作边界'),
    'identity-content.md': ('identity-reference', '身份与协作说明'),
    'cli-permissions.md': ('permission-reference', 'CLI 权限与人工授权'),
    'shared-storage-admin.md': ('storage-reference', '共享空间统计说明'),
    'project-materials-2026-09-21.md': ('materials-reference', '项目资料与附件更新说明'),
    'acceptance-issues-4-5-6.md': ('acceptance-reference', '服务器问题验收说明'),
}
PACKAGE_MARKDOWN = ['user-guide.md', *RELATED]


@dataclass(frozen=True)
class ManualMeta:
    version: str
    software_version: str
    commit: str
    date: str

    @property
    def filename(self) -> str:
        return f'团队工作台使用手册_v{self.version}'

    @property
    def repository_url(self) -> str:
        return f'https://github.com/njuprimarynlper-lgtm/team-agent-workbench/blob/{self.commit}/'


def read_meta(source: Path = SOURCE) -> ManualMeta:
    text = source.read_text(encoding='utf-8')

    def field(label: str, pattern: str) -> str:
        match = re.search(rf'^{re.escape(label)}\s+({pattern})\s*$', text, re.M)
        if not match:
            raise ValueError(f'Missing or invalid {label} in {source}')
        return match.group(1).strip()

    commit_match = re.search(r'^功能核对版本\s+([0-9a-f]{7,40})\s*$', text, re.M)
    commit = commit_match.group(1) if commit_match else subprocess.check_output(
        ['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True,
    ).strip()
    return ManualMeta(
        version=field('文档版本', r'\d+\.\d+(?:\.\d+)?'),
        software_version=field('适用软件版本', r'[^\r\n]+'),
        commit=commit,
        date=field('发布日期', r'\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日'),
    )
