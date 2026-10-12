"""Run on demand over SSH, as an already authorized Linux administrator.

SSH is the only account authentication. A restricted file worker manages public writes.
The Windows admin app sends this fixed program and a JSON request on stdin.
"""
import base64
import datetime
import fnmatch
import hashlib
import json
import os
import pathlib
import posixpath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import uuid
import contextlib
import unicodedata
import zlib
import configparser
import tempfile
import socket
import ipaddress

if "acl_apply" not in globals():
    exec(compile(pathlib.Path(__file__).with_name("acl_support.py").read_text(encoding="utf-8"), "acl_support.py", "exec"))


if "tg_handle" not in globals():
    exec(compile(pathlib.Path(__file__).with_name("group_ops.py").read_text(encoding="utf-8"), "group_ops.py", "exec"))
OPS = {"group_control", "probe", "environment_prepare", "initialize", "status", "storage_usage", "storage_upgrade", "project_catalog", "project_purge", "user_create", "user_password", "user_enabled", "group_create", "user_groups", "group_member", "workspace_prepare", "recover", "egress_jump", "egress_jump_probe"}
REQUIRED_COMMANDS = ["useradd", "usermod", "groupadd", "gpasswd", "chpasswd", "pkill", "sshd", "setfacl"]
MANAGED_SUPERVISOR = pathlib.Path('/etc/team-agent-workbench')
SUPERVISOR_CONFIGS = [pathlib.Path('/etc/supervisor/supervisord.conf'), pathlib.Path('/etc/supervisord.conf'), MANAGED_SUPERVISOR / 'supervisord.conf']
SYSTEMD_UNITS = pathlib.Path('/etc/systemd/system')
INIT_SCRIPTS = pathlib.Path('/etc/init.d')


def systemd_running():
    try:
        return bool(shutil.which('systemctl')) and pathlib.Path('/proc/1/comm').read_text().strip() == 'systemd'
    except OSError:
        return False


def trusted_service_path(path):
    """Check both sides of root-controlled links such as Ubuntu's /var/run -> /run."""
    pending, checked = [path], set()
    while pending:
        current = pending.pop()
        for item in [current, *current.parents]:
            if item in checked:
                continue
            checked.add(item)
            info = item.lstat()
            link = stat.S_ISLNK(info.st_mode)
            if info.st_uid != 0 or (not link and info.st_mode & 0o022):
                raise ValueError('服务配置必须位于 root 拥有且其他账号不可写的目录：' + str(item))
            if link:
                target = item.readlink()
                pending.append(target if target.is_absolute() else item.parent / target)
    try:
        path.resolve(strict=True)
    except RuntimeError as error:
        raise ValueError('服务配置包含循环链接') from error


def service_backend():
    if systemd_running():
        return {'kind': 'systemd'}
    ctl = shutil.which('supervisorctl')
    if ctl:
        for config in SUPERVISOR_CONFIGS:
            if not config.is_file():
                continue
            trusted_service_path(config)
            parser = configparser.RawConfigParser()
            parser.read(config, encoding='utf-8')
            # Never send root service-management commands to a remote Supervisor endpoint.
            url = parser.get('supervisorctl', 'serverurl', fallback='')
            if not url.startswith('unix://'):
                continue
            socket = pathlib.Path(url[len('unix://'):].replace('%(here)s', str(config.parent)))
            if not socket.exists():
                continue
            trusted_service_path(socket)
            if not stat.S_ISSOCK(socket.stat().st_mode):
                continue
            result = subprocess.run([ctl, '-c', str(config), 'pid'], capture_output=True, text=True, timeout=5)
            if result.returncode or not result.stdout.strip().isdigit() or int(result.stdout.strip()) <= 1:
                continue
            includes = parser.get('include', 'files', fallback='').replace('%(here)s', str(config.parent))
            for pattern in shlex.split(includes):
                candidate = pathlib.Path(pattern)
                if not candidate.is_absolute():
                    candidate = config.parent / candidate
                if candidate.name not in ('*.conf', '*.ini') or any(c in str(candidate.parent) for c in '*?[]'):
                    continue
                if not candidate.parent.is_dir():
                    continue
                trusted_service_path(candidate.parent)
                return {'kind': 'supervisor', 'command': ctl, 'config': str(config), 'directory': str(candidate.parent), 'suffix': candidate.suffix, 'managed': config == MANAGED_SUPERVISOR / 'supervisord.conf'}
    raise ValueError('未检测到运行中的 systemd 或可管理的 Supervisor。容器请启动 Supervisor，使用 root 保护的本机 Unix socket，并在主配置的 [include] 中加载 conf.d/*.conf；容器启动命令也须启动同一 Supervisor。当前未配置成员接入。')


def acl_install_hint():
    try:
        values = dict(line.split('=', 1) for line in pathlib.Path('/etc/os-release').read_text().splitlines() if '=' in line)
        family = (values.get('ID', '') + ' ' + values.get('ID_LIKE', '')).replace('"', '').lower()
    except OSError:
        family = ''
    if any(name in family.split() for name in ('ubuntu', 'debian')):
        return 'sudo apt-get update && sudo apt-get install -y acl'
    if any(name in family.split() for name in ('fedora', 'rhel', 'centos', 'rocky', 'almalinux')):
        return 'sudo dnf install -y acl'
    if 'alpine' in family.split():
        return 'sudo apk add acl'
    return '安装发行版的 acl 软件包（Debian/Ubuntu：sudo apt-get install -y acl）'


def environment_probe():
    missing = [name for name in REQUIRED_COMMANDS if not (acl_backend() if name == 'setfacl' else shutil.which(name))]
    issues = []
    if 'setfacl' in missing:
        issues.append('缺少 ACL 工具，暂时无法准备团队目录。请在服务器执行：' + acl_install_hint() + '；安装后点击“重新检查服务器”。')
    other = [name for name in missing if name != 'setfacl']
    if other:
        issues.append('缺少系统命令：' + '、'.join(other) + '。请安装 OpenSSH、shadow/passwd、procps 软件包。')
    manager = None
    notes = []
    try:
        backend = service_backend()
        manager = backend['kind']
        if manager != 'systemd':
            ssh_reload_command(backend)
        if backend.get('managed'):
            notes.append('文件服务使用专用 Supervisor。服务器或容器重启后，需要由启动流程执行 /etc/team-agent-workbench/start-supervisor.sh；当前仅确认本次运行可用。')
    except (ValueError, OSError, configparser.Error, subprocess.SubprocessError) as error:
        issues.append(str(error))
    return {'missingCommands': missing, 'setupIssues': issues, 'setupNotes': notes, 'serviceManager': manager, 'aclBackend': acl_backend()}


def environment_command(command, timeout=600):
    # Package output is never forwarded into the JSON protocol, and may contain proxy URLs.
    with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as output:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'}, timeout=timeout)
        if result.returncode:
            raise RuntimeError('环境准备命令失败（退出码 ' + str(result.returncode) + '）：' + pathlib.Path(command[0]).name + '。请检查软件源、离线包依赖或软件包管理器锁；修复后可重试。')


def prepare_supervisor():
    try:
        return service_backend()
    except ValueError:
        pass
    supervisor = shutil.which('supervisord')
    if not supervisor or not shutil.which('supervisorctl'):
        raise ValueError('Supervisor 尚未安装完整，请补齐 supervisor 软件包。')
    # A dedicated instance never restarts or changes the Supervisor that runs SSH.
    trusted_service_path(MANAGED_SUPERVISOR if MANAGED_SUPERVISOR.exists() else MANAGED_SUPERVISOR.parent)
    MANAGED_SUPERVISOR.mkdir(mode=0o700, exist_ok=True)
    include = MANAGED_SUPERVISOR / 'conf.d'; include.mkdir(mode=0o700, exist_ok=True); trusted_service_path(include)
    runtime = pathlib.Path('/run/team-agent-workbench')
    trusted_service_path(runtime if runtime.exists() else runtime.parent)
    runtime.mkdir(mode=0o700, exist_ok=True)
    config = MANAGED_SUPERVISOR / 'supervisord.conf'
    body = ('[unix_http_server]\nfile=/run/team-agent-workbench/supervisor.sock\nchmod=0700\n'
            '[supervisord]\npidfile=/run/team-agent-workbench/supervisord.pid\nlogfile=/run/team-agent-workbench/supervisord.log\n'
            'logfile_maxbytes=5MB\nlogfile_backups=2\nchildlogdir=/run/team-agent-workbench\n'
            '[rpcinterface:supervisor]\nsupervisor.rpcinterface_factory=supervisor.rpcinterface:make_main_rpcinterface\n'
            '[supervisorctl]\nserverurl=unix:///run/team-agent-workbench/supervisor.sock\n'
            '[include]\nfiles=' + str(include) + '/*.conf\n')
    if config.exists():
        trusted_service_path(config)
        if config.read_text(encoding='utf-8') != body:
            raise ValueError('专用 Supervisor 配置已被修改，不会覆盖；请核对配置。')
    else:
        with config.open('x', encoding='utf-8') as handle: handle.write(body)
        os.chmod(config, 0o600)
    script = MANAGED_SUPERVISOR / 'start-supervisor.sh'
    script_body = ('#!/bin/sh\nset -eu\numask 077\ninstall -d -m 700 /run/team-agent-workbench\n'
                   + shlex.quote(shutil.which('supervisorctl')) + ' -c ' + shlex.quote(str(config)) + ' pid >/dev/null 2>&1 && exit 0\n'
                   + 'exec ' + shlex.quote(supervisor) + ' -c ' + shlex.quote(str(config)) + '\n')
    if script.exists():
        trusted_service_path(script)
        if script.read_text(encoding='utf-8') != script_body: raise ValueError('专用 Supervisor 启动脚本已被修改，不会覆盖。')
    else:
        with script.open('x', encoding='utf-8') as handle: handle.write(script_body)
        os.chmod(script, 0o700)
    environment_command(['/bin/sh', str(script)], timeout=30)
    return service_backend()


def prepare_environment(request):
    source = request.get('source')
    if source not in ('online', 'offline'): raise ValueError('请选择在线或离线准备方式')
    # Online preparation requests only optional components; an offline directory is an explicit package bundle.
    packages = []
    if not acl_backend(): packages.append('acl')
    try: service_backend()
    except ValueError:
        if not shutil.which('supervisord') or not shutil.which('supervisorctl'): packages.append('supervisor')
    if packages:
        apt = shutil.which('apt-get')
        if not apt:
            raise ValueError('自动安装目前支持 Debian/Ubuntu 的 apt-get。其他发行版请安装 acl / supervisor 后重新检查。')
        base = [apt, '-y', '--no-remove', '-o', 'Dpkg::Options::=--force-confold']
        if source == 'online':
            environment_command([apt, '-o', 'APT::Update::Error-Mode=any', 'update'])
            environment_command(base + ['install', *packages])
        else:
            raw = request.get('packageDirectory', '')
            if not isinstance(raw, str) or not raw.startswith('/') or any(c in raw for c in '\x00\n\r'):
                raise ValueError('请填写服务器上的离线软件包绝对目录')
            directory = pathlib.Path(raw)
            trusted_service_path(directory)
            files = sorted(directory.glob('*.deb'))
            if not files or len(files) > 200: raise ValueError('离线目录需要包含 1–200 个与服务器版本、架构匹配的 .deb 包及依赖')
            for file in files:
                trusted_service_path(file)
                if not file.is_file() or file.is_symlink(): raise ValueError('离线包必须是普通文件')
            # apt resolves all local dependency files together; no repository downloads or removal.
            environment_command(base + ['--no-download', 'install', *map(str, files), *packages])
    if not systemd_running(): prepare_supervisor()
    return {'environment': environment_probe(), 'preparedPackages': packages}


def ssh_reload_command(backend):
    if backend['kind'] == 'systemd':
        for name in ('sshd', 'ssh'):
            result = subprocess.run(['systemctl', 'is-active', '--quiet', name], capture_output=True, timeout=5)
            if result.returncode == 0:
                return ['systemctl', 'reload', name]
        raise ValueError('未找到运行中的 ssh/sshd 服务，请先检查 SSH 服务状态。')
    service = shutil.which('service')
    if service:
        for name in ('ssh', 'sshd'):
            script = INIT_SCRIPTS / name
            if script.is_file():
                trusted_service_path(script)
                return [service, name, 'reload']
    raise ValueError('当前容器缺少受支持的 SSH 重载入口，需要 service 以及 /etc/init.d/ssh 或 sshd。不会自动重启或终止 SSH。')


def activate_content_worker(root, program, name, backend):
    python = shutil.which('python3') or '/usr/bin/python3'
    if backend['kind'] == 'systemd':
        unit = SYSTEMD_UNITS / (name + '.service')
        trusted_service_path(unit if unit.exists() else unit.parent)
        unit.write_text('[Unit]\nDescription=Team Agent restricted file operations\nAfter=local-fs.target\n[Service]\nType=simple\nExecStart="' + python.replace('%', '%%') + '" -I "' + str(program).replace('%', '%%') + '" "' + str(root).replace('%', '%%') + '"\nRestart=on-failure\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n[Install]\nWantedBy=multi-user.target\n', encoding='utf-8')
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'enable', '--now', name])
        run(['systemctl', 'restart', name])
        run(['systemctl', 'is-active', '--quiet', name])
    else:
        config = pathlib.Path(backend['directory']) / (name + backend['suffix'])
        trusted_service_path(config if config.exists() else config.parent)
        # Supervisor parses '%' even inside quotes. Avoid its inline ';' comment delimiter.
        if any(c in str(value) for value in (python, program, root) for c in ';\n\r"'):
            raise ValueError('Supervisor 托管路径不能包含分号、双引号或换行，请换用规范的团队目录。')
        command = ' '.join('"' + str(value).replace('%', '%%') + '"' for value in (python, '-I', program, root))
        config.write_text('[program:' + name + ']\ncommand=' + command + '\nuser=root\nautostart=true\nautorestart=true\nstartsecs=1\nstartretries=3\nstopasgroup=true\nkillasgroup=true\numask=0077\nredirect_stderr=true\nstdout_logfile=' + str(program.parent / 'storage-worker.log').replace('%', '%%') + '\nstdout_logfile_maxbytes=5MB\nstdout_logfile_backups=2\n', encoding='utf-8')
        os.chmod(config, 0o600)
        ctl = [backend['command'], '-c', backend['config']]
        run(ctl + ['reread'])
        run(ctl + ['update', name])
        run(ctl + ['restart', name])
        status = run(ctl + ['status', name]).split()
        if len(status) < 2 or status[0] != name or status[1] != 'RUNNING':
            raise RuntimeError('文件服务未进入 RUNNING 状态，成员接入未标记完成；请检查 Supervisor 日志后恢复操作。')

def validate_request(request):
    if not isinstance(request, dict) or request.get("op") not in OPS:
        raise ValueError("不支持的管理操作")
    value = request.get("root", "")
    if not isinstance(value, str) or not value.startswith("/") or any(c in value for c in "\x00\n\r\\\""):
        raise ValueError("共享根路径必须是 Linux 绝对路径")
    parts = pathlib.PurePosixPath(value).parts
    if ".." in parts or len(parts) < 3:
        raise ValueError("请选择专用的共享子目录，例如 /srv/teamspace")
    if str(pathlib.PurePosixPath(value)) != value or any(c in value for c in "\t*"):
        raise ValueError("根路径格式不规范")
    if request['op'] in ['egress_jump', 'egress_jump_probe']:
        egress_target(request)
        if request['op'] == 'egress_jump' and not isinstance(request.get('enabled'), bool):
            raise ValueError('请选择是否允许中转')
    return request


def egress_target(value):
    host, port = value.get('host'), value.get('port')
    if not isinstance(host, str) or not 1 <= len(host) <= 253 or not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError('请输入有效的管理端地址和端口')
    if ':' in host:
        try:
            ipaddress.IPv6Address(host)
        except ValueError:
            raise ValueError('请输入不带方括号的 IPv6 地址')
        if '%' in host:
            raise ValueError('中转地址不支持 IPv6 区域标识')
    elif not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', host) or '..' in host:
        raise ValueError('管理端地址只能是主机名或 IP，不能包含通配符、协议或路径')
    return {'host': host, 'port': port}

def identifier(value, maximum=24):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0," + str(maximum-1) + r"}", value):
        raise ValueError("标识只能由小写字母、数字、下划线和短横线组成，并以字母开头")
    return value

def account_name(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 64
            or unicodedata.category(value[0])[0] not in 'LN'
            or any(unicodedata.category(c)[0] not in 'LN' and c not in '_·-' for c in value)):
        raise ValueError('账号支持中文姓名、数字工号、大小写字母、下划线、短横线和间隔号，最多 64 个字符')
    if re.fullmatch(r'(con|prn|aux|nul|com[1-9]|lpt[1-9])', value, re.IGNORECASE):
        raise ValueError('此账号是系统保留名称，请换一个姓名或工号')
    return value

def group_label(value):
    # Local display name the administrator types; the Linux group name is derived from it.
    message = '项目组名称支持中文、字母、数字、下划线、短横线和间隔号，最多 24 个字符'
    if not isinstance(value, str):
        raise ValueError(message)
    value = unicodedata.normalize('NFC', value)
    if (not 1 <= len(value) <= 24
            or unicodedata.category(value[0])[0] not in 'LN'
            or any(unicodedata.category(c)[0] not in 'LN' and c not in '_-·' for c in value)):
        raise ValueError(message)
    return value

def group_slug(label):
    # Legacy slugs stay byte-identical; anything else (including Chinese) derives a
    # stable ASCII suffix, the same way system_username maps non-ASCII accounts.
    label = unicodedata.normalize('NFC', label)
    return label if re.fullmatch(r'[a-z][a-z0-9_-]{0,13}', label) else 'g' + hashlib.sha256(label.encode('utf-8')).hexdigest()[:13]

def system_username(username):
    # Keep legacy Linux identities; the Windows SSH client uses this same mapping.
    return username if re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', username) else 'wbu_' + hashlib.sha256(username.encode('utf-8')).hexdigest()[:28]

def user_login(state, username):
    record = state['users'][username]
    return identifier(record.get('systemUsername', username), 32)

def check_password(password):
    if not isinstance(password, str) or not 1 <= len(password) <= 4096 or any(c in password for c in '\r\n\x00:'):
        raise ValueError('密码不能为空，不能含换行、冒号或空字符；恢复时请重新输入')
    return password

def run(args, data=None, allowed=(0,)):
    if args[0] == "setfacl":
        return acl_apply(args[1:])
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=30)
    if result.returncode not in allowed:
        # The command payload can contain an initial password on stdin; never log stdin.
        raise RuntimeError(args[0] + " 执行失败：" + result.stderr.strip()[:1500])
    return result.stdout.strip()

def atomic_json(file, value):
    temp = file.with_name(file.name + "." + uuid.uuid4().hex + ".tmp")
    with temp.open("x", encoding="utf-8") as handle:
        os.chmod(temp, 0o600)
        json.dump(value, handle, ensure_ascii=False, indent=2)
    os.replace(temp, file)

def child(root, relative):
    if not isinstance(relative, str) or relative.startswith("/") or ".." in pathlib.PurePosixPath(relative).parts or any(c in relative for c in "\x00\n\r\\"):
        raise ValueError("路径必须位于共享根目录内")
    target = root.joinpath(relative)
    if not target.is_relative_to(root):
        raise ValueError("路径越界")
    cursor = root
    for part in pathlib.PurePosixPath(relative).parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError("管理操作不允许穿过符号链接")
    return target

def root_directory(request):
    root = pathlib.Path(request["root"])
    if str(root.resolve()) != str(root):
        raise ValueError("共享根路径及其上级不得包含符号链接或不规范路径")
    return root

STORAGE_LABELS = {
    "submissions": "成员成果", "trajectories": "会话轨迹", "curated": "团队整理",
    "project": "项目公共内容", "system": "系统数据", "unassigned": "未归属",
}

def project_catalog(root, state):
    projects = []
    for group_id, group in (state.get("groups") or {}).items():
        workspace = group.get("workspace") or ""
        if not workspace or group.get("provisioning") or group.get('deletedAt') or group.get('purgedAt'):
            continue
        base = child(root, workspace[1:] if workspace.startswith("/") else workspace)
        if not base.is_dir() or base.is_symlink():
            continue
        for entry in base.iterdir():
            if entry.name.startswith(".") or entry.is_symlink() or not entry.is_dir():
                continue
            meta_file = entry / ".workbench-project.json"
            if not meta_file.is_file() or meta_file.is_symlink():
                continue
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(meta, dict) or not isinstance(meta.get("id"), str) or not isinstance(meta.get("name"), str):
                continue
            projects.append({"id": meta["id"], "name": meta["name"], "group": group_id, "groupLabel": group.get("label") or group_id, "path": entry.relative_to(root).as_posix()})
    projects.sort(key=lambda item: (item["groupLabel"], item["name"]))
    return {"projects": projects}

def project_json(file, value):
    info = file.stat() if file.is_file() and not file.is_symlink() else file.parent.stat()
    temp = file.with_name("." + uuid.uuid4().hex + ".tmp")
    try:
        with temp.open("x", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False)
        os.chmod(temp, info.st_mode & 0o777 or 0o640)
        try:
            os.chown(temp, info.st_uid, info.st_gid)
        except (OSError, AttributeError):
            pass
        os.replace(temp, file)
    finally:
        temp.unlink(missing_ok=True)

def project_purge(root, state, request):
    project_id, mode = request.get("projectId"), request.get("mode")
    if not isinstance(project_id, str) or not re.fullmatch(r"project_[a-f0-9]{32}", project_id):
        raise ValueError("项目身份无效")
    if mode not in ("all", "keep_trajectories"):
        raise ValueError("请选择清理方式")
    matches = [item for item in project_catalog(root, state)["projects"] if item["id"] == project_id]
    if len(matches) != 1:
        raise ValueError("项目不存在或身份重复，已停止清理")
    found = matches[0]
    directory = child(root, found["path"])
    prefix = "/" + found["path"] + "/trajectories/"
    def listed(file):
        if not file.is_file() or file.is_symlink():
            return []
        try:
            value = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        return value if isinstance(value, list) else []
    def trajectory(entry):
        return isinstance(entry, dict) and isinstance(entry.get("path"), str) and entry["path"].startswith(prefix)
    content_file, history_file = directory / ".workbench-content.json", directory / ".workbench-content-history.json"
    items, history = listed(content_file), listed(history_file)
    if mode == "keep_trajectories":
        items, history = [entry for entry in items if trajectory(entry)], [entry for entry in history if trajectory(entry)]
    else:
        items, history = [], []
    removed = 0
    for entry in list(directory.iterdir()):
        if entry.name in {".workbench-project.json", "项目说明.md", ".brief-versions", ".workbench-content.json", ".workbench-content-history.json"}:
            continue
        if mode == "keep_trajectories" and entry.name == "trajectories":
            continue
        if entry.is_symlink() or entry.is_file():
            entry.unlink()
            removed += 1
            continue
        if entry.is_dir():
            for _current, _dirs, files in os.walk(entry, followlinks=False):
                removed += len(files)
            shutil.rmtree(entry)
    project_json(content_file, items)
    project_json(history_file, history)
    receipt = root / ".workbench/admin/uploads.json"
    if receipt.is_file() and not receipt.is_symlink():
        try:
            data = json.loads(receipt.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = None
        if isinstance(data, dict):
            project_prefix = "/" + found["path"] + "/"
            def retain(value):
                path = value.get("path") if isinstance(value, dict) and isinstance(value.get("path"), str) else ""
                if not path.startswith(project_prefix):
                    return True
                return mode == "keep_trajectories" and path.startswith(prefix)
            trimmed = {key: value for key, value in data.items() if retain(value)}
            if len(trimmed) != len(data):
                project_json(receipt, trimmed)
    return {"projectId": project_id, "name": found["name"], "mode": mode, "removedFiles": removed}

def storage_metrics():
    return {"bytes": 0, "files": 0, "directories": 0, "directBytes": 0}

def storage_add_file(target, size, modified):
    target["bytes"] += size
    target["files"] += 1
    if not target.get("modifiedAt") or modified > target["modifiedAt"]:
        target["modifiedAt"] = modified

def storage_add_directory(target, source):
    target["bytes"] += source["bytes"]
    target["files"] += source["files"]
    target["directories"] += source["directories"] + 1
    if source.get("modifiedAt") and (not target.get("modifiedAt") or source["modifiedAt"] > target["modifiedAt"]):
        target["modifiedAt"] = source["modifiedAt"]

def storage_time(value):
    return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat().replace("+00:00", "Z")

def storage_usage(root, state, request):
    relative = request.get("path", "")
    offset, limit = request.get("offset", 0), request.get("limit", 100)
    if (not isinstance(relative, str) or len(relative) > 2048 or relative.startswith("/") or "\\" in relative
            or "\x00" in relative or (relative and str(pathlib.PurePosixPath(relative)) != relative)
            or any(part in (".", "..") for part in pathlib.PurePosixPath(relative).parts)):
        raise ValueError("目录必须位于共享空间内")
    if not isinstance(offset, int) or not 0 <= offset <= 1000000 or not isinstance(limit, int) or not 1 <= limit <= 200:
        raise ValueError("目录分页参数无效")
    target = child(root, relative) if relative else root
    try:
        target_info = target.lstat()
    except FileNotFoundError:
        raise ValueError("统计目录不存在")
    if stat.S_ISLNK(target_info.st_mode) or not stat.S_ISDIR(target_info.st_mode):
        raise ValueError("统计路径不是共享空间内的普通目录")

    categories = {key: {"key": key, "label": label, **storage_metrics()} for key, label in STORAGE_LABELS.items()}
    groups, users, project_names = {}, {}, {}
    for group_id, group in state.get("groups", {}).items():
        if not group.get("workspace") or group.get("provisioning") or group.get('deletedAt') or group.get('purgedAt'):
            continue
        group_path = group["workspace"].lstrip("/")
        groups[group_id] = {
            "id": group_id, "label": group.get("label", group_id), "path": group_path, "projects": 0,
            "members": sum(group_id in user.get("groups", []) for user in state.get("users", {}).values()),
            "submissionsBytes": 0, "trajectoriesBytes": 0, "curatedBytes": 0,
            "projectBytes": 0, "unassignedBytes": 0, **storage_metrics(),
        }
        project_names[group_id] = set()
    for username, user in state.get("users", {}).items():
        users[username] = {
            "username": username, "name": user.get("name", username), "groups": user.get("groups", []),
            "submissionsBytes": 0, "trajectoriesBytes": 0, **storage_metrics(),
        }
    group_paths = sorted(groups.values(), key=lambda group: len(group["path"]), reverse=True)
    warnings, warning_count = [], 0

    def warn(item, message):
        nonlocal warning_count
        warning_count += 1
        if len(warnings) < 50:
            warnings.append({"path": item, "message": message})

    def classify(item, size, modified):
        segments = [part for part in item.split("/") if part]
        group = next((candidate for candidate in group_paths if item == candidate["path"] or item.startswith(candidate["path"] + "/")), None)
        key = "system" if segments and segments[0].startswith(".workbench") else "unassigned"
        if group:
            storage_add_file(group, size, modified)
            prefix = len(group["path"].split("/"))
            inside = segments[prefix:]
            project_name = inside[0] if inside else None
            if project_name and len(inside) > 1 and inside[-1] == ".workbench-project.json":
                project_names[group["id"]].add(project_name)
            section = inside[1] if len(inside) > 1 else None
            username = inside[2] if len(inside) > 2 else None
            if section in ("submissions", "trajectories") and username in users:
                key = section
                storage_add_file(users[username], size, modified)
                if section == "submissions":
                    users[username]["submissionsBytes"] += size
                    group["submissionsBytes"] += size
                else:
                    users[username]["trajectoriesBytes"] += size
                    group["trajectoriesBytes"] += size
            elif section == "curated":
                key = "curated"
                group["curatedBytes"] += size
            elif len(inside) > 1 and section not in ("submissions", "trajectories"):
                key = "project"
                group["projectBytes"] += size
            else:
                key = "unassigned"
                group["unassignedBytes"] += size
        storage_add_file(categories[key], size, modified)

    def walk(directory, current, depth):
        result = {**storage_metrics(), "children": []}
        if depth > 128:
            warn(current, "目录层级超过 128 层，已停止继续扫描")
            return result
        try:
            with os.scandir(directory) as scan:
                entries = list(scan)
        except PermissionError:
            warn(current, "没有读取权限")
            return result
        except OSError:
            warn(current, "目录读取失败")
            return result
        for entry in entries:
            item = posixpath.join(current, entry.name) if current else entry.name
            try:
                info = entry.stat(follow_symlinks=False)
                modified = storage_time(info.st_mtime)
                if stat.S_ISLNK(info.st_mode):
                    warn(item, "已跳过符号链接")
                elif stat.S_ISDIR(info.st_mode):
                    value = walk(pathlib.Path(entry.path), item, depth + 1)
                    if not value.get("modifiedAt") or modified > value["modifiedAt"]:
                        value["modifiedAt"] = modified
                    storage_add_directory(result, value)
                    result["children"].append({key: value[key] for key in ("bytes", "files", "directories", "directBytes", "modifiedAt")} | {"name": entry.name, "path": item})
                elif stat.S_ISREG(info.st_mode):
                    storage_add_file(result, info.st_size, modified)
                    result["directBytes"] += info.st_size
                    if not relative:
                        classify(item, info.st_size, modified)
                else:
                    warn(item, "已跳过非普通文件")
            except FileNotFoundError:
                warn(item, "扫描过程中已被移动或删除")
            except OSError:
                warn(item, "无法读取文件信息")
        return result

    total = walk(target, relative, 0)
    for group_id, names in project_names.items():
        groups[group_id]["projects"] = len(names)
    children = sorted(total.pop("children"), key=lambda item: (-item["bytes"], item["name"]))
    try:
        volume_info = os.statvfs(root)
        volume = {"totalBytes": volume_info.f_blocks * volume_info.f_frsize, "freeBytes": volume_info.f_bavail * volume_info.f_frsize}
    except (OSError, AttributeError):
        volume = {"totalBytes": 0, "freeBytes": 0}
    return {
        "scannedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "path": relative, "name": pathlib.PurePosixPath(relative).name if relative else "共享空间", "total": total,
        "volume": volume,
        "categories": [] if relative else list(categories.values()),
        "groups": [] if relative else sorted(groups.values(), key=lambda item: -item["bytes"]),
        "users": [] if relative else sorted(users.values(), key=lambda item: -item["bytes"]),
        "children": children[offset:offset + limit], "childCount": len(children), "offset": offset, "limit": limit,
        "warningCount": warning_count, "warnings": warnings,
    }

def allocate_id(records, field, reserved=()):
    used = {getattr(r, field) for r in records} | set(reserved)
    for value in range(1000, 60000):
        if value not in used:
            return value
    raise ValueError("没有可用的专用 UID/GID")

def checkpoint(root, state, step):
    job = state.get("operations", {}).get(state.get("activeOperation"))
    if job and step not in job["completed"]:
        job["completed"].append(step)
    save(root, state)

def provision_group(root, state, record, field, name, step):
    import grp
    if field not in record:
        try:
            grp.getgrnam(name)
        except KeyError:
            pass
        else:
            raise ValueError("同名 Linux 用户组已存在，不能接管：" + name)
        reserved = [state.get("loginGid")] + [g.get(k) for g in state["groups"].values() for k in ["gid", "adminGid"]]
        record[field] = allocate_id(grp.getgrall(), "gr_gid", reserved)
        save(root, state)  # Reserve identity before the mutating command.
    try:
        existing = grp.getgrnam(name)
    except KeyError:
        run(["groupadd", "-g", str(record[field]), name])
        existing = grp.getgrnam(name)
    if existing.gr_gid != record[field]:
        raise ValueError("用户组 GID 已变化，拒绝恢复：" + name)
    checkpoint(root, state, step)

BOOTSTRAP_DIR = pathlib.Path("/var/lib/team-agent-workbench/bootstrap")

def bootstrap_file(root):
    BOOTSTRAP_DIR.mkdir(parents=True, mode=0o700, exist_ok=True)
    for directory in [BOOTSTRAP_DIR, BOOTSTRAP_DIR.parent]:
        info = directory.stat()
        if directory.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("初始化恢复记录目录权限不安全")
    return BOOTSTRAP_DIR / (hashlib.sha256(str(root).encode()).hexdigest() + ".json")

def initialize(root, request):
    journal = bootstrap_file(root)
    if journal.exists():
        state = json.loads(journal.read_text(encoding="utf-8"))
        if state.get("root") != str(root):
            raise ValueError("初始化恢复记录与路径不一致")
    else:
        if root.exists() and any(root.iterdir()):
            raise ValueError("初始化只接受不存在或空的专用目录；不会接管已有非空目录")
        team_id = uuid.uuid4().hex[:8]
        state = {"version": 1, "root": str(root), "teamId": team_id, "name": "团队空间", "loginGroup": "wb_" + team_id + "_members", "users": {}, "initialized": False, "groups": {}, "sftpConfigured": False}
        atomic_json(journal, state)
    root.mkdir(parents=True, exist_ok=True)
    for parent in [root] + list(root.parents)[:-1]:
        info = parent.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("SFTP 根路径及上级必须由 root 拥有且不可被组或其他用户写入")
    os.chmod(root, 0o755)
    for relative in ["projects", ".workbench", ".workbench/users", ".workbench/admin"]:
        directory = child(root, relative)
        directory.mkdir(exist_ok=True)
        os.chmod(directory, 0o700 if relative.endswith("/admin") else 0o711)
    # Once the ordinary registry exists it is the authoritative recovery record.
    if child(root, ".workbench/admin/state.json").exists():
        state = load(root)
        if state.get("initialized"):
            return state
    state.setdefault("operations", {})["initialize"] = {"id": "initialize", "op": "initialize", "request": {"op": "initialize"}, "status": "running", "completed": ["专用目录已建立"]}
    state["activeOperation"] = "initialize"
    save(root, state)
    provision_group(root, state, state, "loginGid", state["loginGroup"], "成员登录组已建立")
    state["initialized"] = True
    state["operations"]["initialize"]["status"] = "done"
    checkpoint(root, state, "团队登记已完成")
    journal.unlink(missing_ok=True)
    return state

def operation_key(request):
    if request['op'] == 'egress_jump':
        return 'egress_jump:' + str(request.get('host')) + ':' + str(request.get('port'))
    if request['op'] == 'group_member':
        return 'group_member:' + str(request.get('username')) + ':' + str(request.get('group'))
    return request["op"] + (":" + str(request.get("username") or request.get("label") or request.get("group")) if any(request.get(k) for k in ["username", "label", "group"]) else "")

def start_operation(root, state, request):
    key = operation_key(request)
    previous = state.setdefault("operations", {}).get(key)
    if previous and previous.get("status") == "done" and request["op"] in ["user_create", "group_create"]:
        raise ValueError("创建已经完成，请刷新查看已有资源")
    sanitized = {k: request[k] for k in ["op", "username", "name", "groups", "contentAdminGroups", "label", "group", "enabled", "role", "host", "port"] if k in request}
    state["operations"][key] = {"id": key, "op": request["op"], "request": sanitized, "status": "running", "completed": previous.get("completed", []) if previous and previous.get("status") != "done" else []}
    state["activeOperation"] = key
    save(root, state)

def assign_groups(root, state, request):
    username = request.get("username")
    ensure_user(state, username)
    login = user_login(state, username)
    groups = request.get("groups", [])
    archived = [name for name in state['users'][username].get('groups',[]) if state['groups'].get(name,{}).get('deletedAt') and not state['groups'][name].get('purgedAt')]
    archived_admins = [name for name in archived if name in state['users'][username].get('contentAdminGroups',[])]
    if isinstance(groups,list): groups = [name for name in groups if name not in archived]
    if not isinstance(groups, list) or any(g not in state["groups"] or not state["groups"][g].get("workspace") or state["groups"][g].get("deletedAt") or state["groups"][g].get("purgedAt") for g in groups):
        raise ValueError("仅可分配已准备好工作目录的团队用户组")
    content_admin_groups = request.get("contentAdminGroups", [])
    if isinstance(content_admin_groups,list): content_admin_groups = [name for name in content_admin_groups if name not in archived]
    if not isinstance(content_admin_groups, list) or any(g not in groups for g in content_admin_groups):
        raise ValueError("组管理员必须是对应项目组成员")
    tg_creator_change(state, username, groups, content_admin_groups)
    groups = list(dict.fromkeys(groups + archived)); content_admin_groups = list(dict.fromkeys(content_admin_groups + archived_admins))
    desired = set(groups) | {state["groups"][g]["adminGroup"] for g in content_admin_groups}
    managed = set(state["groups"]) | {g["adminGroup"] for g in state["groups"].values()}
    import grp
    current = {g.gr_name for g in grp.getgrall() if login in g.gr_mem}
    for group in managed & current - desired:
        run(["gpasswd", "-d", login, group])
    if desired:
        run(["usermod", "-a", "-G", ",".join(sorted(desired)), login])
    state["users"][username]["groups"] = list(groups)
    state["users"][username]["contentAdminGroups"] = content_admin_groups
    checkpoint(root, state, "成员组与组管理员角色已设置")
    terminate_connections(login)
    checkpoint(root, state, "旧连接已失效")


def load(root):
    file = child(root, ".workbench/admin/state.json")
    if not file.is_file():
        raise ValueError("此目录尚未初始化为团队空间")
    return json.loads(file.read_text(encoding="utf-8"))

def write_roles(root, state):
    tg_publish_roles(root, state)
    if state.get("storageVersion") == 1:
        prepare_request_directories(root, state)
    return


def save(root, state):
    atomic_json(child(root, ".workbench/admin/state.json"), state)
    # Legacy state files did not persist ordinary memberships. Always publish
    # the current OS assignments, including during unrelated password/group edits.
    write_roles(root, actual_state(state))


def prepare_request_directories(root, state):
    for kind in ('inbox', 'outbox'):
        base = child(root, '.workbench/' + kind)
        base.mkdir(exist_ok=True)
        os.chown(base, 0, 0)
        os.chmod(base, 0o711)
        for username, user in state['users'].items():
            if user.get('uid') is None:
                continue
            directory = child(root, '.workbench/' + kind + '/' + user_login(state, username))
            directory.mkdir(exist_ok=True)
            os.chown(directory, 0, 0)
            run(['setfacl', '-b', '-k', str(directory)])
            os.chmod(directory, 0o700)
            if user.get('enabled'):
                run(['setfacl', '-m', 'u:' + str(user['uid']) + (':rwx' if kind == 'inbox' else ':r-x'), str(directory)])


def protect_public_tree(root, state):
    for group in state['groups'].values():
        if not group.get('workspace'):
            continue
        directory = child(root, group['workspace'].lstrip('/'))
        paths = [directory] + list(directory.rglob('*'))
        if any(file.is_symlink() or file.is_file() and file.stat().st_nlink != 1 for file in paths):
            raise ValueError('公共区存在符号链接或硬链接，请管理员先处理后再启用受控存储')
        for file in paths:
            if not file.is_dir() and not file.is_file():
                raise ValueError('公共区只支持普通文件和目录')
            os.chown(file, 0, group['gid'])
            run(['setfacl', '-b', '-k', str(file)] if file.is_dir() else ['setfacl', '-b', str(file)])
            os.chmod(file, 0o2750 if file.is_dir() else 0o640)


def install_content_worker(root, state, reconnect=True, backend=None):
    backend = backend or service_backend()
    encoded = globals().get('CONTENT_WORKER_ZLIB_BASE64') or globals().get('CONTENT_WORKER_BASE64')
    if not encoded:
        raise ValueError('管理员程序缺少文件操作器，请使用完整新版管理员包')
    program = child(root, '.workbench/admin/content.py')
    payload = base64.b64decode(encoded, validate=True)
    program.write_bytes(zlib.decompress(payload) if globals().get('CONTENT_WORKER_ZLIB_BASE64') else payload)
    os.chown(program, 0, 0)
    os.chmod(program, 0o700)
    prepare_request_directories(root, state)
    protect_public_tree(root, state)
    name = 'team-agent-storage-' + state['teamId']
    activate_content_worker(root, program, name, backend)
    for username, user in state['users'].items():
        if reconnect and user.get('enabled') and not user.get('provisioning'):
            terminate_connections(user_login(state, username))
    state['storageVersion'] = 1
    state['storageServiceManager'] = backend['kind']


def member_access_file(state):
    return pathlib.Path("/etc/ssh/sshd_config.d") / ("80-workbench-" + state["teamId"] + ".conf")


def member_access_config(root, state):
    targets = [egress_target(value) for value in state.get('egressJumpTargets', [])]
    forwarding = '    DisableForwarding yes\n'
    if targets:
        destinations = ' '.join(('[' + item['host'] + ']' if ':' in item['host'] else item['host']) + ':' + str(item['port']) for item in targets)
        forwarding = ('    DisableForwarding no\n    AllowTcpForwarding local\n    PermitOpen ' + destinations + '\n'
                      '    AllowStreamLocalForwarding no\n    AllowAgentForwarding no\n    X11Forwarding no\n    PermitTunnel no\n')
    return ('Match Group ' + state["loginGroup"] + '\n    ChrootDirectory "' + str(root) + '"\n    ForceCommand internal-sftp\n    PasswordAuthentication yes\n    AuthenticationMethods password\n    PubkeyAuthentication no\n' + forwarding + '    PermitTTY no\nMatch all\n')


def sshd_includes_member_access(file, config_file=pathlib.Path("/etc/ssh/sshd_config")):
    """Return whether sshd's global config includes the generated rule file.

    A commented Include, or an Include inside another Match block, does not load
    the team's rule for arbitrary members. Merely searching for the directory
    name caused both cases to be reported as configured while nologin answered
    the member's SFTP subsystem request.
    """
    target = posixpath.normpath(str(file).replace("\\", "/"))
    config_name = str(config_file).replace("\\", "/")
    global_scope = True
    for raw in config_file.read_text(encoding="utf-8").splitlines():
        try:
            parts = shlex.split(raw, comments=True, posix=True)
        except ValueError:
            return False
        if not parts:
            continue
        keyword = parts[0].lower()
        if keyword == "match":
            global_scope = len(parts) == 2 and parts[1].lower() == "all"
            continue
        if keyword != "include" or not global_scope:
            continue
        for value in parts[1:]:
            pattern = value if value.startswith("/") else posixpath.join(posixpath.dirname(config_name), value)
            if fnmatch.fnmatchcase(target, posixpath.normpath(pattern)):
                return True
    return False


def enable_member_access_include(file, config_file=pathlib.Path("/etc/ssh/sshd_config")):
    """Enable the team's drop-in directory and return prior main config text."""
    if sshd_includes_member_access(file, config_file):
        return None
    if config_file.is_symlink() or not config_file.is_file():
        raise ValueError("sshd_config 不是可安全更新的普通文件")
    previous = config_file.read_text(encoding="utf-8")
    include = "Include " + posixpath.dirname(str(file).replace("\\", "/")) + "/*.conf\n"
    config_file.write_text(include + previous, encoding="utf-8")
    if not sshd_includes_member_access(file, config_file):
        config_file.write_text(previous, encoding="utf-8")
        raise ValueError("无法启用 sshd_config drop-in Include")
    return previous


def member_access_ready(root, state):
    """Reject stale state that claims SFTP is ready after its SSH rule changed."""
    if not state.get("sftpConfigured") or state.get("storageVersion") != 1:
        return False
    file = member_access_file(state)
    try:
        return (file.is_file()
                and file.read_text(encoding="utf-8") == member_access_config(root, state)
                and sshd_includes_member_access(file))
    except OSError:
        return False


def apply_member_access_rule(root, state, backend=None):
    """Validate before reload; restore the old configuration if applying fails."""
    backend = backend or service_backend()
    reload_command = ssh_reload_command(backend)
    file = member_access_file(state)
    config_dir = file.parent
    config_dir.mkdir(exist_ok=True)
    main_config = pathlib.Path("/etc/ssh/sshd_config")
    config = member_access_config(root, state)
    previous = file.read_text(encoding="utf-8") if file.exists() else None
    previous_main = None
    try:
        previous_main = enable_member_access_include(file, main_config)
        file.write_text(config, encoding="utf-8")
        run([shutil.which("sshd") or "/usr/sbin/sshd", "-t"])
        run(reload_command)
    except Exception:
        if previous is None:
            file.unlink(missing_ok=True)
        else:
            file.write_text(previous, encoding="utf-8")
        if previous_main is not None:
            main_config.write_text(previous_main, encoding="utf-8")
        raise


def configure_member_access(root, state):
    """Install member login and storage plumbing as part of user creation."""
    backend = service_backend()
    apply_member_access_rule(root, state, backend)
    install_content_worker(root, state, backend=backend)
    state["sftpConfigured"] = True


def configure_egress_jump(root, state, request):
    if not state.get('sftpConfigured') or state.get('storageVersion') != 1:
        raise ValueError('请先完成团队成员的 SFTP 登录配置')
    target = egress_target(request)
    targets = list(state.get('egressJumpTargets', []))
    if request['enabled']:
        if target not in targets:
            if len(targets) >= 16:
                raise ValueError('最多允许 16 个管理端出口，请先移除不用的地址')
            targets.append(target)
    else:
        targets = [item for item in targets if item != target]
    apply_member_access_rule(root, {**state, 'egressJumpTargets': targets})
    state['egressJumpTargets'] = targets
    checkpoint(root, state, '共享服务器中转规则已应用')
    # Existing SSH connections retain their original PermitOpen policy. Revoking
    # an endpoint must close them; adding one only requires affected users to log in again.
    if not request['enabled']:
        for username in state.get('users', {}):
            terminate_connections(user_login(state, username))
        checkpoint(root, state, '旧成员连接已失效')


def probe_egress_jump(request):
    target = egress_target(request)
    try:
        with socket.create_connection((target['host'], target['port']), timeout=5):
            pass
    except OSError:
        raise ValueError('共享服务器无法连接管理端，请检查出口是否运行、地址、端口及双方防火墙；若出站仅放行 80/443/2202，可将管理端出口配置为允许的空闲端口') from None
    return {'reachable': True}


def prepare_workspace(root, state, group_name):
    import grp
    group = state["groups"].get(group_name)
    if not group:
        raise ValueError("用户组不属于此团队")
    if not acl_backend():
        raise ValueError("服务器缺少 setfacl，请先安装发行版的 acl 软件包")
    label = group_label(group.get("label"))
    target = child(root, "projects/" + label)
    if target.exists() and not group.get("workspace") and any(target.iterdir()):
        raise ValueError("工作目录已存在且非空，不会接管，请运维检查：" + str(target))
    if target.exists() and target.stat().st_uid != 0:
        raise ValueError("工作目录必须由 root 拥有")
    target.mkdir(mode=0o700, exist_ok=True)
    os.chown(target, 0, grp.getgrnam(group_name).gr_gid)
    os.chmod(target, 0o2770)
    # Members can enter/list this parent; only the content-admin group can create projects.
    run(["setfacl", "-b", "-k", str(target)])
    run(["setfacl", "-m", "u::rwx,g::r-x,g:" + group["adminGroup"] + ":rwx,m::rwx,o::---", str(target)])
    # New project content is collaborative, submissions are group-readable and trajectories remain private.
    run(["setfacl", "-d", "-m", "u::rwx,g::rwx,g:" + group["adminGroup"] + ":rwx,m::rwx,o::---", str(target)])
    group["workspace"] = "/projects/" + label
    if state.get("storageVersion") == 1:
        run(["setfacl", "-b", "-k", str(target)])
        os.chmod(target, 0o2750)

def ensure_user(state, username):
    account_name(username)
    if username not in state["users"]:
        raise ValueError("只允许操作由此团队空间创建的成员账号")
    import pwd
    current = pwd.getpwnam(user_login(state, username))
    if current.pw_uid == 0 or current.pw_uid != state["users"][username]["uid"]:
        raise ValueError("Linux 账号身份已被外部修改，拒绝操作")

def terminate_connections(username):
    # All accounts created by this application are dedicated SFTP accounts.
    run(["pkill", "-KILL", "-u", username], allowed=(0, 1))

def actual_state(state):
    import grp, pwd, copy
    result = copy.deepcopy(state)
    today = (datetime.datetime.now(datetime.timezone.utc).date() - datetime.date(1970, 1, 1)).days
    shadows = {line.split(":")[0]: line.split(":") for line in pathlib.Path("/etc/shadow").read_text().splitlines()}
    for name, user in result["users"].items():
        try:
            login = user_login(state, name)
            record = pwd.getpwnam(login)
            shadow = shadows[login]
            expires = int(shadow[7]) if shadow[7] else -1
            user["identity"] = tg_identity(user)
            user["missing"] = record.pw_uid != user["uid"]
            user["enabled"] = not user["missing"] and not shadow[1].startswith(("!", "*")) and (expires < 0 or expires > today)
            user["groups"] = [g.gr_name for g in grp.getgrall() if login in g.gr_mem or g.gr_gid == record.pw_gid]
        except KeyError:
            user["missing"] = True
            user["enabled"] = False
            user["groups"] = []
    return result

@contextlib.contextmanager
def state_lock(request):
    import fcntl
    # Shared by all administrators; this file cannot be replaced by ordinary users.
    directory = pathlib.Path("/run/team-agent-admin")
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != 0 or directory.stat().st_mode & 0o077:
        raise PermissionError("管理锁目录权限不安全")
    key = hashlib.sha256(request["root"].encode()).hexdigest()
    with (directory / key).open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield

def enforce_continuity(root, state, request):
    if request['op'] == 'group_member' and request.get('role') not in ('member', 'admin', 'remove'):
        raise ValueError('无效成员操作')
    if request['op'] not in ('user_enabled', 'user_groups', 'group_member'):
        return
    username = request.get('username')
    current = actual_state(state)
    user = current['users'].get(username)
    if not user or not user.get('enabled'):
        return
    promotions = []
    for group in user.get('contentAdminGroups', []):
        if current['groups'][group].get('deletedAt') or current['groups'][group].get('purgedAt'):
            continue
        op = request['op']
        losing = (op == 'user_enabled' and request.get('enabled') is False) or (op == 'group_member' and request.get('group') == group and request.get('role') != 'admin') or (op == 'user_groups' and (group not in request.get('groups', []) or group not in request.get('contentAdminGroups', [])))
        others = [u for name, u in current['users'].items() if name != username and u.get('enabled') and not u.get('missing') and not u.get('provisioning') and group in u.get('groups', []) and group in u.get('contentAdminGroups', [])]
        if not losing or others:
            continue
        handoffs = request.get('handoffs', {})
        if group not in handoffs:
            raise ValueError('此操作将移除最后一位组管理员，请选择接任人或明确保留空缺：' + current['groups'][group]['label'])
        successor = handoffs[group]
        if successor is None:
            continue
        selected = current['users'].get(successor)
        if successor == username or not selected or not selected.get('enabled') or selected.get('missing') or selected.get('provisioning') or group not in selected.get('groups', []):
            raise ValueError('接任人必须是本组其他已启用成员')
        promotions.append((successor, group, selected))
    for successor, group, selected in promotions:
        assign_groups(root, state, {'username': successor, 'groups': selected.get('groups', []), 'contentAdminGroups': list(set(selected.get('contentAdminGroups', []) + [group]))})


def _execute(request):
    validate_request(request)
    if sys.platform != "linux" or os.geteuid() != 0:
        raise PermissionError("需要已有的 Linux root 或 sudo 管理权限；安装管理员版不赋予服务器权限")
    root = root_directory(request)
    actor = os.environ.get("SUDO_USER") or "root"
    if request['op'] == 'environment_prepare':
        return prepare_environment(request)
    missing = [name for name in REQUIRED_COMMANDS if not (acl_backend() if name == 'setfacl' else shutil.which(name))]
    if request["op"] == "probe":
        return {"administrator": True, "actor": actor, "root": str(root), **environment_probe(), "initialized": (root / ".workbench/admin/state.json").is_file()}
    if request['op'] == 'egress_jump_probe':
        return {'state': actual_state(load(root)), 'value': probe_egress_jump(request)}
    if request["op"] == "status" and not (root / ".workbench/admin/state.json").is_file():
        journal = bootstrap_file(root)
        return {"initialized": False, "users": {}, "groups": {}, "bootstrapPending": journal.exists()}
    if request["op"] == "storage_usage":
        if not (root / ".workbench/admin/state.json").is_file():
            raise ValueError("请先初始化团队空间")
        return storage_usage(root, load(root), request)
    if request["op"] in ("project_catalog", "project_purge"):
        if not (root / ".workbench/admin/state.json").is_file():
            raise ValueError("请先初始化团队空间")
        state = load(root)
        return project_catalog(root, state) if request["op"] == "project_catalog" else project_purge(root, state, request)
    if missing and request['op'] != 'status':
        hint = '；ACL 安装命令：' + acl_install_hint() if 'setfacl' in missing else ''
        raise ValueError("服务器缺少命令：" + ", ".join(missing) + "。请先安装发行版的 OpenSSH、shadow/passwd、procps、acl 软件包" + hint)
    op = request["op"]
    if isinstance(request.get("label"), str):
        # Same visible name typed in a different Unicode form must land on one record, one journal key and one directory.
        request["label"] = unicodedata.normalize('NFC', request["label"])
    if op == "initialize":
        service_backend()
        state = initialize(root, request)
    else:
        state = load(root)
        if op != "status":
            if not state.get("initialized"):
                raise ValueError("请先恢复并完成初始化")
            start_operation(root, state, request)
    result = None
    enforce_continuity(root, state, request)
    if op == "status":
        current = actual_state(state)
        current["sftpConfigured"] = member_access_ready(root, state)
        if not missing:
            write_roles(root, current)
        return current
    if op == "user_create":
        import pwd, grp
        username = account_name(request.get("username"))
        login = system_username(username)
        password = check_password(request.get("password", ""))
        groups = request.get("groups", [])
        if any(g not in state["groups"] or not state["groups"][g].get("workspace") or state["groups"][g].get("deletedAt") or state["groups"][g].get("purgedAt") for g in groups) or any(g not in groups for g in request.get("contentAdminGroups", [])):
            raise ValueError("请选择已准备好的用户组，组管理员须属于对应组")
        if not member_access_ready(root, state):
            configure_member_access(root, state)
            checkpoint(root, state, "成员登录能力已配置")
        record = state["users"].get(username)
        if not record:
            if any(n.lower() == username.lower() or user_login(state, n) == login for n in state['users']):
                raise ValueError('账号已存在（不允许创建仅大小写不同的重名账号）')
            try:
                pwd.getpwnam(login)
            except KeyError:
                pass
            else:
                raise ValueError("Linux 账号已存在，工具不会接管已有系统账号")
            record = {"username": username, "systemUsername": login, "uid": allocate_id(pwd.getpwall(), "pw_uid", [u.get("uid") for u in state["users"].values()]), "name": str(request.get("name", username))[:120], "enabled": True, "provisioning": True, "marker": "workbench-" + state["teamId"] + "-" + login}
            state["users"][username] = record
            save(root, state)
        elif not record.get("provisioning"):
            raise ValueError("账号已创建完成，请使用重置密码或组管理入口")
        login = user_login(state, username)
        shell = shutil.which("nologin") or "/usr/sbin/nologin"
        try:
            current = pwd.getpwnam(login)
        except KeyError:
            run(["useradd", "-M", "-u", str(record["uid"]), "-c", record["marker"], "-d", "/", "-s", shell, "-g", state["loginGroup"], login])
            current = pwd.getpwnam(login)
        if current.pw_uid != record["uid"] or current.pw_gecos != record["marker"] or current.pw_gid != grp.getgrnam(state["loginGroup"]).gr_gid:
            raise ValueError("账号身份与创建记录不符，拒绝恢复")
        checkpoint(root, state, "专用账号已创建")
        run(["chpasswd"], login + ":" + password + "\n")
        checkpoint(root, state, "初始密码已设置")
        assign_groups(root, state, request)
        record["provisioning"] = False
    elif op == "user_password":
        username = request.get("username")
        ensure_user(state, username)
        login = user_login(state, username)
        password = check_password(request.get("password", ""))
        run(["chpasswd"], login + ":" + password + "\n")
        terminate_connections(login)
    elif op == "user_enabled":
        username = request.get("username")
        ensure_user(state, username)
        login = user_login(state, username)
        enabled = request.get("enabled") is True
        run(["usermod", "--expiredate", "" if enabled else "1", login])
        state["users"][username]["enabled"] = enabled
        checkpoint(root, state, "账号登录状态已设置")
        if not enabled:
            terminate_connections(login)
    elif op == "group_control":
        result = tg_handle(root, state, None, request.get('command'), system=True)
    elif op == "group_create":
        label = group_label(request.get("label"))
        name = "wb_" + state["teamId"] + "_" + group_slug(label)
        import grp
        if not acl_backend():
            raise ValueError("创建项目组工作目录需要 setfacl，请先安装发行版的 acl 软件包")
        record = state["groups"].get(name)
        if not record:
            collision = next((g for g in state["groups"].values() if str(g.get("label", "")).casefold() == label.casefold()), None)
            if collision:
                raise ValueError("已存在同名或仅大小写不同的项目组：" + collision["label"])
            target = child(root, "projects/" + label)
            if target.exists() and any(target.iterdir()):
                raise ValueError("同名工作目录已存在且非空，不能自动接管")
            for candidate in [name, name + "_admin"]:
                try:
                    grp.getgrnam(candidate)
                except KeyError:
                    continue
                raise ValueError("同名 Linux 用户组已存在，不能接管：" + candidate)
            record = {"name": name, "label": label, "adminGroup": name + "_admin", "provisioning": True}
            state["groups"][name] = record
            save(root, state)
        elif record.get("label") != label:
            # The derived Linux name is not injective; never complete another group's record.
            raise ValueError("项目组名称与已有项目组冲突，请换一个名称：" + str(record.get("label", "")))
        elif not record.get("provisioning"):
            raise ValueError("用户组已存在且创建完成")
        provision_group(root, state, record, "gid", name, "成员用户组已创建")
        provision_group(root, state, record, "adminGid", record["adminGroup"], "组管理员用户组已创建")
        prepare_workspace(root, state, name)
        record["provisioning"] = False
        checkpoint(root, state, "工作目录与 ACL 已配置")
    elif op == "workspace_prepare":
        prepare_workspace(root, state, request.get("group"))
        checkpoint(root, state, "工作目录与 ACL 已配置")
    elif op == 'egress_jump':
        configure_egress_jump(root, state, request)
    elif op == "storage_upgrade":
        if not member_access_ready(root, state):
            raise ValueError('请先完成成员 SFTP 登录配置')
        install_content_worker(root, state, reconnect=False)
        checkpoint(root, state, '文件操作器已更新')
    elif op == "user_groups":
        assign_groups(root, state, request)
    elif op == "group_member":
        username = request.get('username')
        ensure_user(state, username)
        group = request.get('group')
        record = state['groups'].get(group)
        role = request.get('role')
        if not record or not record.get('workspace') or record.get('provisioning') or record.get('deletedAt') or record.get('purgedAt'):
            raise ValueError('项目组不存在或工作目录尚未准备好')
        if role not in ['member', 'admin', 'remove']:
            raise ValueError('无效成员操作')
        if state['users'][username].get('provisioning'):
            raise ValueError('请先完成用户开通')
        import grp
        # Read current OS membership while holding the team lock. A group-level
        # change must not overwrite assignments made from another admin window.
        login = user_login(state, username)
        current = {g.gr_name for g in grp.getgrall() if login in g.gr_mem}
        groups = set(state['groups']) & current
        admins = {name for name, g in state['groups'].items() if g['adminGroup'] in current and name in groups}
        if role == 'remove': groups.discard(group)
        else: groups.add(group)
        if role == 'admin': admins.add(group)
        else: admins.discard(group)
        assign_groups(root, state, {**request, 'groups': sorted(groups), 'contentAdminGroups': sorted(admins)})
    if op != "status":
        job = state.get("operations", {}).get(state.get("activeOperation"))
        if job:
            job["status"] = "done"
            job.pop("error", None)
        save(root, state)
        with child(root, ".workbench/admin/audit.jsonl").open("a", encoding="utf-8") as audit:
            json.dump({"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "actor": actor, "operation": op, "username": request.get("username"), "groups": request.get("groups"), "label": request.get("label"), "group": request.get("group"), "role": request.get("role"), **({"host": request['host'], "port": request['port'], "enabled": request['enabled']} if op == 'egress_jump' else {})}, audit, ensure_ascii=False)
            audit.write("\n")
    return {"state": actual_state(state), "value": result}

def execute(request):
    validate_request(request)
    if sys.platform != "linux" or os.geteuid() != 0:
        raise PermissionError("需要已有 Linux root 或 sudo 管理权限")
    root = root_directory(request)
    if request["op"] == "recover":
        state = load(root)
        job = state.get("operations", {}).get(request.get("operationId"))
        if not job or job.get("status") == "done":
            raise ValueError("没有可恢复的未完成操作")
        request = {**job["request"], "root": request["root"], "password": request.get("password", "")}
    try:
        return _execute(request)
    except Exception as error:
        if request["op"] not in ["status", "probe", "storage_usage", "project_catalog", "project_purge", "environment_prepare", "egress_jump_probe"]:
            try:
                state = load(root)
                key = operation_key(request)
                job = state.get("operations", {}).get(key)
                if job and job.get("status") != "done":
                    job["status"] = "failed"
                    job["error"] = str(error)[:1500]
                    save(root, state)
            except Exception:
                pass
        raise

def main(request):
    validate_request(request)
    if sys.platform != "linux" or os.geteuid() != 0:
        raise PermissionError("需要已有 Linux root 或 sudo 管理权限")
    if request["op"] in ["probe", "storage_usage"]:
        return execute(request)
    with state_lock(request):
        return execute(request)

if __name__ == "__main__":
    # The SSH bootstrap already read its code from stdin. Use the same binary
    # stream, without reconfiguring or mixing it with a text read-ahead buffer.
    sys.stdout.reconfigure(encoding="utf-8")
    print("WORKBENCH_READY", flush=True)
    try:
        request = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
        result = main(request)
        print(json.dumps({"ok": True, "value": result}, ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
