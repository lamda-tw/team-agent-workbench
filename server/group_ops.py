"""Bounded project-group operations; only the root worker calls these functions.

The caller identity is supplied by the SSH inbox verifier, never by JSON.
System administration is supplied by the root-only management entry point.
"""
import hashlib as _tg_hash
import json as _tg_json
import os as _tg_os
import pathlib as _tg_path
import subprocess as _tg_process
import datetime as _tg_date
import unicodedata as _tg_unicode
import uuid as _tg_uuid
import shutil as _tg_shutil
import re as _tg_re

def tg_now():
    return _tg_date.datetime.now(_tg_date.timezone.utc).isoformat()

def tg_identity(user):
    return _tg_hash.sha256(_tg_json.dumps([user['username'], user.get('uid'), user.get('marker')]).encode()).hexdigest()

def tg_enabled(user):
    return bool(user and user.get('enabled') and not user.get('missing') and not user.get('provisioning'))

def tg_role(state, group, username):
    user = state['users'].get(username)
    name = group.get('name') or next((key for key,value in state['groups'].items() if value is group), None)
    if not tg_enabled(user) or group.get('deletedAt') or group.get('provisioning') or name not in user.get('groups', []):
        return None
    if group.get('creator') and group.get('creator') == dict(username=username, identity=tg_identity(user)):
        return 'creator'
    return 'manager' if name in user.get('contentAdminGroups', []) else 'member'

def tg_safe(root, relative):
    if not isinstance(relative, str) or '\\' in relative or any(ord(c) < 32 for c in relative):
        raise ValueError('非法项目组路径')
    current = root
    for part in relative.lstrip('/').split('/'):
        if part in ('', '.', '..'):
            raise ValueError('非法项目组路径')
        current = current / part
        if current.is_symlink():
            raise PermissionError('项目组操作不允许符号链接')
    return current

def tg_json(file, value, mode=0o600):
    temp = file.parent / ('.' + _tg_uuid.uuid4().hex + '.tmp')
    file.parent.mkdir(parents=True, exist_ok=True)
    try:
        with temp.open('x', encoding='utf-8') as stream:
            _tg_json.dump(value, stream, ensure_ascii=False); stream.flush(); _tg_os.fsync(stream.fileno())
        _tg_os.chmod(temp, mode); _tg_os.replace(temp, file)
    finally:
        temp.unlink(missing_ok=True)

def tg_publish_roles(root, state):
    roles = dict(version=1, membershipVersion=1, groupRolesVersion=1, root=str(root), storageVersion=state.get('storageVersion', 0), users={})
    for username, user in state['users'].items():
        if not tg_enabled(user):
            continue
        groups = []
        for name in user.get('groups', []):
            group = state['groups'].get(name)
            if not group or group.get('deletedAt') or group.get('purgedAt'):
                continue
            groups.append(dict(id=name, name=group['label'], workspace=group.get('workspace') if not group.get('provisioning') else None, role=tg_role(state,group,username), creator=group.get('creator', {}).get('username')))
        roles['users'][username] = dict(groups=groups, contentGroups=[group for group in groups if group['role'] in ('creator', 'manager')])
    tg_json(tg_safe(root,'.workbench/roles.json'), roles, 0o644)

def tg_save(root, state):
    tg_json(tg_safe(root,'.workbench/admin/state.json'), state)
    tg_publish_roles(root, state)

def tg_committed(root, group):
    # Publication may fail after the private state was atomically committed.
    # Keep filesystem moves in that case; never expose a deleted group again.
    saved = _tg_json.loads(tg_safe(root,'.workbench/admin/state.json').read_text(encoding='utf-8'))
    return saved.get('groups', {}).get(group['name']) == group

def tg_provision(root, state, group):
    import grp
    owner = state['users'].get(group['creator']['username'])
    if not tg_enabled(owner) or group['creator']['identity'] != tg_identity(owner):
        raise PermissionError('创建者账号未启用或身份已改变，请管理端先核对账号')
    tg_account(owner)
    for field, name in [('gid',group['name']),('adminGid',group['adminGroup'])]:
        if field not in group:
            try: grp.getgrnam(name)
            except KeyError: pass
            else: raise PermissionError('同名 Linux 组已存在，拒绝接管')
            used = {native.gr_gid for native in grp.getgrall()} | {value.get(key) for value in state['groups'].values() for key in ('gid','adminGid')} | {state.get('loginGid')}
            group[field] = next((gid for gid in range(1000,60000) if gid not in used), None)
            if group[field] is None: raise ValueError('没有可用的项目组 GID')
            tg_save(root,state)  # Reserve the native identity before running groupadd.
        try: native = grp.getgrnam(name)
        except KeyError:
            tg_run(['groupadd','-g',str(group[field]),'--',name]); native=grp.getgrnam(name)
        if native.gr_gid != group[field]: raise PermissionError('Linux 项目组身份已改变，拒绝继续创建')
    directory=tg_safe(root,group['workspace'])
    if directory.exists():
        stat=directory.stat()
        if not directory.is_dir() or stat.st_uid!=0 or stat.st_gid!=group['gid']:
            raise PermissionError('项目组目录身份不符，拒绝接管')
    else:
        directory.mkdir(mode=0o700); _tg_os.chown(directory,0,group['gid'])
    _tg_os.chmod(directory,0o2750)
    tg_set_member(state,group,owner,'manager'); group['provisioning']=False

def tg_run(arguments, allowed=(0,)):
    result = _tg_process.run(arguments, stdin=_tg_process.DEVNULL, stdout=_tg_process.PIPE, stderr=_tg_process.PIPE, text=True, timeout=30)
    if result.returncode not in allowed:
        raise RuntimeError('项目组系统权限设置未完成，请管理端核对后重试：' + arguments[0])

def tg_account(user):
    import pwd
    account = pwd.getpwnam(user.get('systemUsername', user['username']))
    if account.pw_uid == 0 or account.pw_uid != user.get('uid') or account.pw_gecos != user.get('marker'):
        raise PermissionError('系统账号身份已改变')
    return account

def tg_acl(arguments):
    if 'acl_apply' not in globals():
        exec(compile(_tg_path.Path(__file__).with_name('acl_support.py').read_text(encoding='utf-8'),'acl_support.py','exec'), globals())
    acl_apply(arguments)

def tg_set_member(state, group, user, role):
    import grp
    account = tg_account(user); login = account.pw_name
    # An explicit UID entry overrides stale supplementary groups in an existing SSH process.
    if group.get('workspace') and not group.get('deletedAt'):
        tg_acl(['-m', 'u:'+str(account.pw_uid)+(':'+'---' if role=='remove' else ':r-x'), str(tg_safe(_tg_path.Path(state['root']),group['workspace']))])
    gids = set(_tg_os.getgrouplist(login, account.pw_gid))
    for name, gid, include in [(group['name'],group['gid'],role!='remove'), (group['adminGroup'],group['adminGid'],role=='manager')]:
        native = grp.getgrnam(name)
        if native.gr_gid != gid:
            raise PermissionError('Linux 项目组身份已改变')
        if include and gid not in gids: tg_run(['usermod','-a','-G',name,login])
        elif not include and gid in gids: tg_run(['gpasswd','-d',login,name])
    gids = set(_tg_os.getgrouplist(login, account.pw_gid))
    user['groups'] = [name for name, value in state['groups'].items() if value.get('gid') in gids]
    user['contentAdminGroups'] = [name for name in user['groups'] if state['groups'][name].get('adminGid') in gids]

def tg_disconnect(user):
    account = tg_account(user)
    tg_run(['pkill','-KILL','-u',account.pw_name], (0,1))

def tg_creator_change(state, username, groups=None, admins=None):
    user = state['users'].get(username)
    if not user: return
    for group in state['groups'].values():
        if not group.get('deletedAt') and group.get('creator') and group.get('creator') == dict(username=username,identity=tg_identity(user)):
            if (groups is not None and group['name'] not in groups) or (admins is not None and group['name'] not in admins):
                raise ValueError('请先在项目组管理中移交创建者权限：' + group['label'])

def tg_describe(root, state, group, actor=None):
    members = []
    for username, user in sorted(state['users'].items()):
        if group['name'] not in user.get('groups', []): continue
        creator = bool(group.get('creator')) and group.get('creator') == dict(username=username, identity=tg_identity(user))
        members.append(dict(username=username,name=user.get('name',username),enabled=tg_enabled(user),role='creator' if creator else 'manager' if group['name'] in user.get('contentAdminGroups',[]) else 'member'))
    directory = tg_safe(root, group['recyclePath'] if group.get('deletedAt') else group['workspace'])
    projects = []; size = 0; count = 0; fingerprint = _tg_hash.sha256()
    if directory.exists():
        for candidate in sorted(directory.iterdir()):
            if candidate.is_symlink(): raise PermissionError('项目组包含符号链接，请管理员核对')
            if candidate.is_dir() and not candidate.name.startswith('.'):
                marker = candidate / '.workbench-project.json'
                if marker.is_symlink(): raise PermissionError('项目身份文件不能是符号链接')
                if marker.is_file():
                    data = _tg_json.loads(marker.read_text(encoding='utf-8'))
                    if data.get('id'): projects.append(dict(id=data['id'],name=data['name']))
        for base, directories, files in _tg_os.walk(directory, followlinks=False):
            directories.sort()
            for name in sorted(directories + files):
                target = _tg_path.Path(base) / name; count += 1
                if count > 500000: raise ValueError('项目组文件过多，请管理员先核对空间统计')
                if target.is_symlink(): raise PermissionError('项目组包含符号链接，请管理员核对')
                info=target.stat()
                fingerprint.update(_tg_json.dumps([str(target.relative_to(directory)),info.st_ino,info.st_mtime_ns,info.st_size]).encode())
                if target.is_file(): size += info.st_size
    elif not group.get('purgeStartedAt') and not group.get('provisioning'): raise ValueError('项目组目录缺失，请管理端核对')
    revision = _tg_hash.sha256(_tg_json.dumps([group,members,projects,size,fingerprint.hexdigest()],sort_keys=True).encode()).hexdigest()
    return dict(id=group['name'],label=group['label'],revision=revision,role=tg_role(state,group,actor) if actor else None,creator=group.get('creator',{}).get('username'),createdBy=group.get('createdBy'),deletedAt=group.get('deletedAt'),deletedBy=group.get('deletedBy'),members=members,projects=projects,bytes=size,purgeStartedAt=group.get('purgeStartedAt'),provisioning=group.get('provisioning',False))

def tg_handle(root, state, actor, command, system=False):
    if not isinstance(command,dict): raise ValueError('项目组请求格式无效')
    state.setdefault('root', str(root))
    action = command.get('action'); user = state['users'].get(actor) if actor else None
    if action not in ('list','create','details','directory','member','transfer','delete','restore','purge','resume'): raise ValueError('不支持的项目组操作')
    if not system and not tg_enabled(user): raise PermissionError('账号未启用或身份已改变')
    if not system and action=='create' and 'creator' in command: raise PermissionError('创建者由当前登录身份确定')
    group = state['groups'].get(command.get('group')) if action not in ('list','create') else None
    if action not in ('list','create') and (not group or group.get('purgedAt') or group.get('provisioning') and not (system and action in ('details','resume'))): raise ValueError('项目组不存在或尚未准备好')
    role = tg_role(state,group,actor) if group and actor else None
    if group and not system and not role: raise PermissionError('没有此项目组的访问权限')
    if action=='list': return [tg_describe(root,state,value,actor) for value in state['groups'].values() if value.get('workspace') and not value.get('purgedAt') and (system or tg_role(state,value,actor))]
    if action=='details': return tg_describe(root,state,group,actor)
    if not system and role!='creator' and action!='create': raise PermissionError('只有本组创建者可以管理成员或删除项目组')
    if action=='directory': return [dict(username=name,name=value.get('name',name)) for name,value in state['users'].items() if tg_enabled(value)]
    if group and command.get('revision')!=tg_describe(root,state,group,actor)['revision']: raise ValueError('项目组成员或内容已变化，请刷新后重新确认')
    if group and group.get('deletedAt') and action not in ('restore','purge'): raise ValueError('项目组已删除，请由管理端恢复')
    if action in ('restore','purge','resume') and not system: raise PermissionError('只有管理端可以恢复、继续创建或彻底清理项目组')
    disconnect = []
    if action=='create':
        label = _tg_unicode.normalize('NFC',str(command.get('label','')).strip())
        if not label or len(label)>24 or not label[0].isalnum() or any(not c.isalnum() and c not in '_·-' for c in label): raise ValueError('项目组名称不合法')
        creator = command.get('creator') if system else actor; owner = state['users'].get(creator)
        if not tg_enabled(owner): raise ValueError('请选择已启用的创建者账号')
        tg_account(owner)
        if any(value['label'].casefold()==label.casefold() for value in state['groups'].values() if not value.get('purgedAt')): raise ValueError('项目组名称已存在；删除的组需先恢复或彻底清理')
        name = 'wb_' + str(state['teamId'])[:12] + '_g' + _tg_uuid.uuid4().hex[:7]
        directory = tg_safe(root,'projects/'+label)
        if directory.exists(): raise ValueError('同名目录已存在，不会接管')
        import grp
        for candidate in (name,name+'_admin'):
            try: grp.getgrnam(candidate)
            except KeyError: pass
            else: raise ValueError('同名 Linux 组已存在，不会接管')
        group = dict(name=name,label=label,adminGroup=name+'_admin',workspace='/projects/'+label,creator=dict(username=creator,identity=tg_identity(owner)),createdBy=creator,createdAt=tg_now(),provisioning=True)
        state['groups'][name]=group; tg_save(root,state)
        tg_provision(root,state,group)
    elif action=='resume':
        if not group.get('provisioning'): raise ValueError('项目组已准备完成，无需继续创建')
        tg_provision(root,state,group)
    elif action in ('member','transfer'):
        username=command.get('username'); target=state['users'].get(username)
        if not tg_enabled(target): raise ValueError('目标账号不存在或未启用；创建账号请使用管理端')
        tg_account(target)
        if action=='member':
            if command.get('role') not in ('manager','member','remove'): raise ValueError('无效项目组角色')
            if group.get('creator')==dict(username=username,identity=tg_identity(target)): raise PermissionError('请先移交创建者权限，不能直接移除或降级创建者')
            tg_set_member(state,group,target,command['role'])
        else:
            if not system and group['name'] not in target.get('groups',[]): raise ValueError('接任创建者必须是本组已有成员')
            tg_set_member(state,group,target,'manager'); group['creator']=dict(username=username,identity=tg_identity(target))
        if username!=actor: disconnect.append(target)
    elif action=='delete':
        directory=tg_safe(root,group['workspace']); trash='.workbench/admin/group-trash/'+group['name']; target=tg_safe(root,trash)
        target.parent.mkdir(mode=0o700,parents=True,exist_ok=True); _tg_os.chmod(target.parent,0o700)
        if target.exists(): raise ValueError('回收位置已存在，请管理端核对')
        _tg_os.rename(directory,target)
        group.update(deletedAt=tg_now(),deletedBy=actor or '系统管理员',recyclePath='/'+trash)
        try: tg_save(root,state)
        except Exception:
            if not tg_committed(root,group):
                _tg_os.rename(target,directory)
                for key in ('deletedAt','deletedBy','recyclePath'): group.pop(key,None)
            raise
        disconnect=[value for name,value in state['users'].items() if name!=actor and group['name'] in value.get('groups',[]) and tg_enabled(value)]
    elif action=='restore':
        if not group.get('deletedAt') or group.get('purgeStartedAt'): raise ValueError('项目组未删除或已经开始彻底清理')
        source=tg_safe(root,group['recyclePath']); target=tg_safe(root,group['workspace'])
        if target.exists(): raise ValueError('原位置已被占用，不能覆盖恢复')
        _tg_os.rename(source,target); saved={key:group.pop(key) for key in ('deletedAt','deletedBy','recyclePath')}
        try: tg_save(root,state)
        except Exception:
            if not tg_committed(root,group): group.update(saved); _tg_os.rename(target,source)
            raise
    elif action=='purge':
        if not group.get('deletedAt'): raise ValueError('只能彻底清理回收站内的项目组')
        expected='/.workbench/admin/group-trash/'+group['name']
        if group.get('recyclePath')!=expected: raise PermissionError('回收路径不合法')
        target=tg_safe(root,expected)
        group['purgeStartedAt']=group.get('purgeStartedAt') or tg_now(); tg_save(root,state)
        for value in state['users'].values():
            if group['name'] in value.get('groups',[]): tg_set_member(state,group,value,'remove')
        if target.exists(): _tg_shutil.rmtree(target)
        import grp
        for field,name in [('gid',group['name']),('adminGid',group['adminGroup'])]:
            try: native=grp.getgrnam(name)
            except KeyError: continue
            if native.gr_gid!=group[field]: raise PermissionError('Linux 组身份已改变，拒绝清理')
            tg_run(['groupdel','--',name])
        group['purgedAt']=tg_now()
    tg_save(root,state)
    audit=tg_safe(root,'.workbench/admin/audit.jsonl')
    with audit.open('a',encoding='utf-8') as stream: stream.write(_tg_json.dumps(dict(at=tg_now(),actor=actor or '系统管理员',operation='team_group',action=action,group=group['name'],username=command.get('username')),ensure_ascii=False)+'\n')
    _tg_os.chmod(audit,0o600)
    for target in disconnect:
        try: tg_disconnect(target)
        except (RuntimeError,KeyError): pass  # Business authorization already rejects future writes.
    return [] if action=='purge' else tg_describe(root,state,group,actor)
