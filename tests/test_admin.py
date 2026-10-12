import importlib.util
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('admin_program', pathlib.Path(__file__).parents[1] / 'server/admin.py')
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)

class AdminSafetyTests(unittest.TestCase):
    def test_jump_rule_is_sftp_only_and_limits_exact_destinations(self):
        state = {'loginGroup': 'wb_test_members'}
        self.assertIn('DisableForwarding yes', admin.member_access_config('/srv/teamspace', state))
        state['egressJumpTargets'] = [{'host': 'admin.internal', 'port': 443}, {'host': '::1', 'port': 18443}]
        rule = admin.member_access_config('/srv/teamspace', state)
        for directive in ['ForceCommand internal-sftp', 'ChrootDirectory "/srv/teamspace"', 'PermitTTY no', 'AllowTcpForwarding local', 'AllowStreamLocalForwarding no', 'AllowAgentForwarding no', 'X11Forwarding no', 'PermitTunnel no', 'PermitOpen admin.internal:443 [::1]:18443']:
            self.assertIn(directive, rule)
        for host in ['*', 'x\nMatch all', 'x y', 'https://admin', '[::1]', 'a..b', '::1%zone']:
            with self.assertRaises(ValueError): admin.egress_target({'host': host, 'port': 443})
        for port in [0, 65536, True, '443']:
            with self.assertRaises(ValueError): admin.egress_target({'host': 'admin', 'port': port})

    def test_jump_rule_rolls_back_if_sshd_validation_or_reload_fails(self):
        import tempfile
        for failing_step in [0, 1]:
            with tempfile.TemporaryDirectory() as folder:
                file = pathlib.Path(folder) / 'member.conf'
                file.write_text('previous rule', encoding='utf-8')
                with patch.object(admin, 'service_backend', return_value='systemd'), patch.object(admin, 'ssh_reload_command', return_value=['reload']), patch.object(admin, 'member_access_file', return_value=file), patch.object(admin, 'enable_member_access_include', return_value=None), patch.object(admin, 'run', side_effect=[RuntimeError('failed')] if failing_step == 0 else [None, RuntimeError('failed')]):
                    with self.assertRaisesRegex(RuntimeError, 'failed'):
                        admin.apply_member_access_rule('/srv/teamspace', {'loginGroup': 'wb_test_members'})
                self.assertEqual(file.read_text(encoding='utf-8'), 'previous rule')

    def test_jump_probe_only_opens_one_tcp_connection_and_hides_raw_errors(self):
        with patch.object(admin.socket, 'create_connection') as connect:
            self.assertEqual(admin.probe_egress_jump({'host': 'admin', 'port': 443}), {'reachable': True})
            connect.assert_called_once_with(('admin', 443), timeout=5)
        with patch.object(admin.socket, 'create_connection', side_effect=OSError('raw diagnostic')):
            with self.assertRaisesRegex(ValueError, '共享服务器无法连接') as failure:
                admin.probe_egress_jump({'host': 'admin', 'port': 443})
            self.assertNotIn('raw diagnostic', str(failure.exception))

    def test_operation_and_path_validation(self):
        for root in ['/','/etc','/srv/../etc','/srv/x\nMatch All','/srv/x*','/srv/x/']:
            with self.assertRaises(ValueError): admin.validate_request({'op':'status','root':root})
        for op in ['write','project_create','acl_set','run_shell']:
            with self.assertRaises(ValueError): admin.validate_request({'op':op,'root':'/srv/teamspace'})

    def test_client_choice_cannot_grant_root(self):
        with patch.object(admin.sys, 'platform', 'linux'), patch.object(admin.os, 'geteuid', return_value=1001, create=True):
            with self.assertRaises(PermissionError): admin.main({'op':'user_create','root':'/srv/teamspace','administrator':True})

    def test_recreated_or_root_account_cannot_be_managed(self):
        fake = types.SimpleNamespace(getpwnam=lambda name: types.SimpleNamespace(pw_uid=0))
        with patch.dict(sys.modules, {'pwd': fake}):
            with self.assertRaises(ValueError): admin.ensure_user({'users':{'alice':{'uid':1001}}}, 'alice')

    def test_password_is_stdin_not_command_argument(self):
        result = types.SimpleNamespace(returncode=0,stdout='',stderr='')
        with patch.object(admin.subprocess,'run',return_value=result) as run:
            admin.run(['chpasswd'],'alice:secret\n')
            self.assertEqual(run.call_args.args[0],['chpasswd'])
            self.assertEqual(run.call_args.kwargs['input'],'alice:secret\n')
            self.assertNotIn('shell',run.call_args.kwargs)

    def test_removing_subadmin_revokes_only_managed_group_and_existing_connections(self):
        state = {'initialized': True, 'sftpConfigured': True, 'storageVersion': 1, 'users': {'alice': {'uid': 1001}}, 'groups': {'wb_t_ocr': {'adminGroup': 'wb_t_ocr_admin', 'workspace': '/projects/ocr'}}}
        fake_grp = types.SimpleNamespace(getgrall=lambda: [types.SimpleNamespace(gr_name=g, gr_mem=['alice']) for g in ['wb_t_ocr','wb_t_ocr_admin','external']])
        fake_pwd = types.SimpleNamespace(getpwnam=lambda name: types.SimpleNamespace(pw_uid=1001))
        import tempfile
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {'grp':fake_grp, 'pwd':fake_pwd}), patch.object(admin.sys,'platform','linux'), patch.object(admin.os,'geteuid',return_value=0,create=True), patch.object(admin.shutil,'which',side_effect=lambda n:n), patch.object(admin,'root_directory',return_value=pathlib.Path(temp)), patch.object(admin,'load',return_value=state), patch.object(admin,'save'), patch.object(admin,'actual_state',side_effect=lambda v:v), patch.object(admin,'run') as run:
            (pathlib.Path(temp)/'.workbench/admin').mkdir(parents=True)
            admin.execute({'op':'user_groups','root':'/srv/teamspace','username':'alice','groups':['wb_t_ocr'],'contentAdminGroups':[]})
            commands = [call.args[0] for call in run.call_args_list]
            self.assertIn(['gpasswd','-d','alice','wb_t_ocr_admin'], commands)
            self.assertIn(['pkill','-KILL','-u','alice'], commands)
            self.assertFalse(any('external' in c for c in commands))
            self.assertEqual(state['users']['alice']['contentAdminGroups'],[])

    def test_group_workspace_gives_creation_right_only_to_subadmins(self):
        import tempfile
        state = {'groups': {'wb_test_ocr': {'label':'ocr','adminGroup':'wb_test_ocr_admin'}}}
        fake_grp = types.SimpleNamespace(getgrnam=lambda name: types.SimpleNamespace(gr_gid=1001))
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {'grp':fake_grp}), patch.object(admin.os,'chown',create=True), patch.object(admin.shutil,'which',return_value='/usr/bin/setfacl'), patch.object(admin,'run') as run:
            root = pathlib.Path(temp)
            (root/'projects').mkdir()
            admin.prepare_workspace(root,state,'wb_test_ocr')
            commands = [c.args[0] for c in run.call_args_list]
            self.assertTrue(any('u::rwx,g::r-x,g:wb_test_ocr_admin:rwx,m::rwx,o::---' in c for c in commands))
            self.assertEqual(state['groups']['wb_test_ocr']['workspace'],'/projects/ocr')
            self.assertTrue((root/'projects/ocr').is_dir())

    def test_group_names_accept_chinese_and_derive_linux_identifiers(self):
        self.assertEqual(admin.group_label('实体抽取'), '实体抽取')
        self.assertEqual(admin.group_slug('ocr'), 'ocr')
        self.assertEqual(admin.group_slug('ocr_name-1'), 'ocr_name-1')
        self.assertRegex(admin.group_slug('实体抽取'), r'^g[a-f0-9]{13}$')
        self.assertEqual(admin.group_slug('实体抽取'), admin.group_slug(admin.group_label('实体抽取')))
        # Same visible name in a different Unicode form must land on the same Linux name.
        self.assertEqual(admin.group_label('é'), admin.group_label('é'))
        self.assertEqual(admin.group_slug('é'), admin.group_slug('é'))
        for value in ['实体/抽取', '..', '.hidden', '-bad', 'a b', 'x' * 25, '', None, 3]:
            with self.assertRaises(ValueError): admin.group_label(value)

    def test_workspace_initialization_does_not_take_over_existing_content(self):
        import tempfile
        state = {'groups': {'wb_test_ocr': {'label':'ocr','adminGroup':'wb_test_ocr_admin'}}}
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {'grp':types.SimpleNamespace()}), patch.object(admin.shutil,'which',return_value='/usr/bin/setfacl'):
            root = pathlib.Path(temp)
            (root/'projects/ocr').mkdir(parents=True)
            (root/'projects/ocr/existing.txt').write_text('preserve')
            with self.assertRaisesRegex(ValueError,'非空'): admin.prepare_workspace(root,state,'wb_test_ocr')
            self.assertEqual((root/'projects/ocr/existing.txt').read_text(),'preserve')

    def test_storage_usage_is_read_only_scoped_and_attributes_member_content(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            state = {
                'initialized': True,
                'users': {'alice': {'username': 'alice', 'name': 'Alice', 'groups': ['wb_test_ocr']}},
                'groups': {'wb_test_ocr': {'name': 'wb_test_ocr', 'label': 'OCR', 'adminGroup': 'wb_test_ocr_admin', 'workspace': '/projects/OCR'}},
            }
            files = {
                'projects/OCR/demo/.workbench-project.json': b'{}',
                'projects/OCR/demo/submissions/alice/result.bin': b'a' * 10,
                'projects/OCR/demo/trajectories/alice/run.zip': b'b' * 20,
                'projects/OCR/demo/curated/final.md': b'c' * 30,
                '.workbench/roles.json': b'd' * 5,
            }
            for name, content in files.items():
                file = root/name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(content)
            outside = root.parent/'outside-storage-test'; outside.mkdir(exist_ok=True)
            (outside/'secret.bin').write_bytes(b'x' * 200)
            try:
                linked = True
                try:
                    (root/'linked').symlink_to(outside, target_is_directory=True)
                except OSError:
                    linked = False
                result = admin.storage_usage(root, state, {'path': '', 'offset': 0, 'limit': 100})
                categories = {item['key']: item['bytes'] for item in result['categories']}
                self.assertEqual(categories['submissions'], 10)
                self.assertEqual(categories['trajectories'], 20)
                self.assertEqual(categories['curated'], 30)
                self.assertEqual(categories['system'], 5)
                self.assertEqual(result['groups'][0]['projects'], 1)
                self.assertEqual(result['users'][0]['bytes'], 30)
                self.assertEqual(result['warningCount'], 1 if linked else 0)
                self.assertEqual(result['total']['bytes'], sum(map(len, files.values())))
                with self.assertRaises(ValueError): admin.storage_usage(root, state, {'path': '../outside-storage-test', 'offset': 0, 'limit': 100})
            finally:
                import shutil
                shutil.rmtree(outside, ignore_errors=True)

class AdminRecoveryTests(unittest.TestCase):
    def test_jump_changes_preserve_other_admins_and_revocation_disconnects_old_permissions(self):
        self.execute('user_create', username='alice', name='Alice', password='test-password')
        with patch.object(admin, 'apply_member_access_rule') as apply:
            self.execute('egress_jump', host='admin-a', port=443, enabled=True)
            self.execute('egress_jump', host='admin-b', port=18443, enabled=True)
            self.assertEqual(len(admin.load(self.root)['egressJumpTargets']), 2)
            self.execute('egress_jump', host='admin-a', port=443, enabled=True)
            self.assertEqual(len(admin.load(self.root)['egressJumpTargets']), 2)
            self.fail = lambda args: args[0] == 'pkill'
            with self.assertRaises(RuntimeError): self.execute('egress_jump', host='admin-a', port=443, enabled=False)
            failed = admin.load(self.root)
            self.assertEqual(failed['egressJumpTargets'], [{'host': 'admin-b', 'port': 18443}])
            self.assertEqual(failed['operations']['egress_jump:admin-a:443']['request']['host'], 'admin-a')
            self.fail = None
            self.execute('recover', operationId='egress_jump:admin-a:443')
            self.assertEqual(admin.load(self.root)['operations']['egress_jump:admin-a:443']['status'], 'done')
            self.assertIn(['pkill', '-KILL', '-u', 'alice'], self.calls)
            self.assertEqual(apply.call_args.args[1]['egressJumpTargets'], [{'host': 'admin-b', 'port': 18443}])

    def test_failed_jump_update_retains_previous_targets_and_probe_does_not_write_state(self):
        before = (self.root / '.workbench/admin/state.json').read_bytes()
        with patch.object(admin.socket, 'create_connection'):
            self.execute('egress_jump_probe', host='admin-a', port=443)
        self.assertEqual((self.root / '.workbench/admin/state.json').read_bytes(), before)
        with patch.object(admin, 'apply_member_access_rule', side_effect=RuntimeError('invalid ssh config')):
            with self.assertRaises(RuntimeError): self.execute('egress_jump', host='admin-a', port=443, enabled=True)
        self.assertEqual(admin.load(self.root).get('egressJumpTargets', []), [])

    def test_saving_legacy_state_preserves_ordinary_membership_from_system(self):
        import json
        self.execute('group_create', label='ocr')
        self.execute('user_create', username='alice', name='Alice', password='1', groups=['wb_test_ocr'])
        state = admin.load(self.root)
        del state['users']['alice']['groups']
        original_read = pathlib.Path.read_text
        def read(file, *args, **kwargs):
            if file.as_posix() == '/etc/shadow': return 'alice:hash:1:0:99999:7:::'
            return original_read(file, *args, **kwargs)
        with patch.object(admin, 'actual_state', side_effect=self.actual_state), patch.object(pathlib.Path, 'read_text', read):
            admin.save(self.root, state)
        roles = json.loads((self.root/'.workbench/roles.json').read_text(encoding='utf-8'))
        self.assertEqual([g['id'] for g in roles['users']['alice']['groups']], ['wb_test_ocr'])
        self.assertEqual(roles['users']['alice']['contentGroups'], [])

    def test_membership_manifest_includes_all_enabled_accounts_and_refresh_migrates_legacy_roles(self):
        import json
        for label in ['ocr', 'nlp']: self.execute('group_create', label=label)
        self.execute('user_create', username='alice', name='Alice', password='1', groups=['wb_test_ocr', 'wb_test_nlp'], contentAdminGroups=['wb_test_ocr'])
        self.execute('user_create', username='test1', name='Test', password='1')
        self.execute('user_create', username='disabled', name='Disabled', password='1')
        self.execute('user_enabled', username='disabled', enabled=False)
        file = self.root/'.workbench/roles.json'
        file.write_text(json.dumps({'version': 1, 'users': {}}), encoding='utf-8')
        self.execute('status')
        roles = json.loads(file.read_text(encoding='utf-8'))
        self.assertEqual(roles['membershipVersion'], 1)
        self.assertEqual(set(roles['users']), {'alice', 'test1'})
        self.assertEqual(roles['users']['test1'], {'groups': [], 'contentGroups': []})
        self.assertEqual([g['workspace'] for g in roles['users']['alice']['groups']], ['/projects/ocr', '/projects/nlp'])
        self.assertEqual([g['id'] for g in roles['users']['alice']['contentGroups']], ['wb_test_ocr'])
        self.assertNotIn('password', file.read_text(encoding='utf-8'))
        self.execute('group_member', username='alice', group='wb_test_ocr', role='remove', handoffs={'wb_test_ocr':None})
        updated = json.loads(file.read_text(encoding='utf-8'))['users']['alice']
        self.assertEqual([g['id'] for g in updated['groups']], ['wb_test_nlp'])
        self.assertEqual(updated['contentGroups'], [])

    def test_extended_accounts_use_system_identity_for_all_commands_and_preserve_alias_roles(self):
        import json
        self.execute('group_create', label='ocr')
        for username in ['张三', '10086', 'ZhangSan']:
            self.execute('user_create', username=username, name=username, password='1', groups=['wb_test_ocr'], contentAdminGroups=['wb_test_ocr'])
            state = admin.load(self.root)
            login = state['users'][username]['systemUsername']
            self.assertRegex(login, r'^wbu_[a-f0-9]{28}$')
            self.assertIn(login, self.users)
            self.assertNotIn(username, self.users)
            self.assertIn((['chpasswd'], login + ':1\n'), self.inputs)
            self.assertIn(['pkill', '-KILL', '-u', login], self.calls)
            roles = json.loads((self.root/'.workbench/roles.json').read_text(encoding='utf-8'))
            self.assertIn(username, roles['users'])
            shadow = '\n'.join(n + ':hash:1:0:99999:7:::' for n in self.users)
            with patch.object(pathlib.Path, 'read_text', return_value=shadow):
                status = self.actual_state(state)
            self.assertFalse(status['users'][username]['missing'])
            self.assertIn('wb_test_ocr', status['users'][username]['groups'])
            self.execute('user_password', username=username, password='2')
            self.assertIn((['chpasswd'], login + ':2\n'), self.inputs)
            self.execute('user_enabled', username=username, enabled=False, handoffs={'wb_test_ocr':None})
            self.assertIn(['usermod', '--expiredate', '1', login], self.calls)
            self.execute('user_enabled', username=username, enabled=True)
            self.execute('group_member', username=username, group='wb_test_ocr', role='remove', handoffs={'wb_test_ocr':None})
            self.assertNotIn(login, self.groups['wb_test_ocr'].gr_mem)
            self.assertIn(['gpasswd', '-d', login, 'wb_test_ocr_admin'], self.calls)
        with self.assertRaisesRegex(ValueError, '已存在'):
            self.execute('user_create', username='zhangsan', name='', password='1')
        with self.assertRaisesRegex(ValueError, '已存在'):
            self.execute('user_create', username=admin.system_username('10086'), name='', password='1')

    def test_extended_account_recovery_and_empty_password_rejection(self):
        self.fail = lambda a: a[0] == 'chpasswd'
        with self.assertRaises(RuntimeError): self.execute('user_create', username='10086', name='工号', password='1')
        self.fail = None
        with self.assertRaisesRegex(ValueError, '不能为空'): self.execute('recover', operationId='user_create:10086', password='')
        self.execute('recover', operationId='user_create:10086', password='2')
        state = admin.load(self.root)
        self.assertFalse(state['users']['10086']['provisioning'])
        self.assertEqual(sum(a[0] == 'useradd' for a in self.calls), 1)
        with self.assertRaisesRegex(ValueError, '不能为空'): self.execute('user_password', username='10086', password='')
        self.users[admin.system_username('10086')].pw_uid = 55555
        with self.assertRaisesRegex(ValueError, '身份'): self.execute('user_enabled', username='10086', enabled=False)

    def test_group_member_preserves_other_roles_and_external_membership(self):
        for label in ['ocr', 'nlp']: self.execute('group_create', label=label)
        self.execute('user_create', username='alice', name='Alice', password='test-password')
        self.groups['external'] = types.SimpleNamespace(gr_name='external', gr_gid=9999, gr_mem=['alice'])
        self.execute('group_member', username='alice', group='wb_test_ocr', role='admin')
        self.execute('group_member', username='alice', group='wb_test_nlp', role='admin')
        self.execute('group_member', username='alice', group='wb_test_ocr', role='remove', handoffs={'wb_test_ocr':None})
        state = admin.load(self.root)
        self.assertEqual(state['users']['alice']['contentAdminGroups'], ['wb_test_nlp'])
        self.assertNotIn('alice', self.groups['wb_test_ocr'].gr_mem)
        self.assertNotIn('alice', self.groups['wb_test_ocr_admin'].gr_mem)
        self.assertIn('alice', self.groups['wb_test_nlp'].gr_mem)
        self.assertIn('alice', self.groups['external'].gr_mem)
        self.execute('group_member', username='alice', group='wb_test_ocr', role='member')
        self.execute('group_member', username='alice', group='wb_test_nlp', role='member', handoffs={'wb_test_nlp':None})
        self.assertEqual(admin.load(self.root)['users']['alice']['contentAdminGroups'], [])
        self.assertIn('alice', self.groups['wb_test_nlp'].gr_mem)

    def test_editing_active_membership_preserves_recycled_group_roles(self):
        for label in ['ocr', 'nlp']: self.execute('group_create', label=label)
        self.execute('user_create',username='alice',name='Alice',password='test-password',groups=['wb_test_ocr','wb_test_nlp'],contentAdminGroups=['wb_test_ocr'])
        state=admin.load(self.root);state['groups']['wb_test_ocr']['deletedAt']='2026-10-12T00:00:00Z';admin.save(self.root,state)
        self.execute('user_groups',username='alice',groups=['wb_test_nlp'],contentAdminGroups=[])
        user=admin.load(self.root)['users']['alice']
        self.assertEqual(set(user['groups']),{'wb_test_ocr','wb_test_nlp'});self.assertEqual(user['contentAdminGroups'],['wb_test_ocr'])
        self.assertIn('alice',self.groups['wb_test_ocr'].gr_mem);self.assertIn('alice',self.groups['wb_test_ocr_admin'].gr_mem)
        with self.assertRaisesRegex(ValueError,'项目组不存在'):self.execute('group_member',username='alice',group='wb_test_ocr',role='admin')

    def test_disabling_account_persists_denial_before_disconnect_failure(self):
        self.execute('user_create',username='alice',name='Alice',password='test-password')
        self.fail=lambda args:args[0]=='pkill'
        with self.assertRaises(RuntimeError):self.execute('user_enabled',username='alice',enabled=False)
        self.assertFalse(admin.load(self.root)['users']['alice']['enabled'])
        self.assertIn('账号登录状态已设置',admin.load(self.root)['operations']['user_enabled:alice']['completed'])

    def test_group_member_recovery_preserves_newer_assignment_and_rejects_bad_roles(self):
        for label in ['ocr', 'nlp']: self.execute('group_create', label=label)
        self.execute('user_create', username='alice', name='Alice', password='test-password')
        self.fail = lambda args: args[0] == 'pkill'
        with self.assertRaises(RuntimeError): self.execute('group_member', username='alice', group='wb_test_ocr', role='admin')
        self.fail = None
        self.execute('group_member', username='alice', group='wb_test_nlp', role='admin')
        self.execute('recover', operationId='group_member:alice:wb_test_ocr')
        state = admin.load(self.root)
        self.assertEqual(set(state['users']['alice']['contentAdminGroups']), {'wb_test_ocr', 'wb_test_nlp'})
        self.assertEqual(state['operations']['group_member:alice:wb_test_ocr']['status'], 'done')
        with self.assertRaisesRegex(ValueError, '无效成员操作'): self.execute('group_member', username='alice', group='wb_test_ocr', role='root')
        with self.assertRaisesRegex(ValueError, '项目组不存在'): self.execute('group_member', username='alice', group='missing', role='member')

    def setUp(self):
        import contextlib, tempfile, copy
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = pathlib.Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        (self.root/'.workbench/admin').mkdir(parents=True)
        (self.root/'projects').mkdir()
        self.groups = {'wb_test_members': types.SimpleNamespace(gr_name='wb_test_members', gr_gid=1000, gr_mem=[])}
        self.users = {}
        self.calls = []
        self.inputs = []
        self.actual_state = admin.actual_state
        self.member_access_ready = admin.member_access_ready
        self.fail = None
        def lookup(mapping, name):
            if name not in mapping: raise KeyError(name)
            return mapping[name]
        self.stack.enter_context(patch.dict(sys.modules, {
            'grp': types.SimpleNamespace(getgrnam=lambda n:lookup(self.groups,n),getgrall=lambda:list(self.groups.values())),
            'pwd': types.SimpleNamespace(getpwnam=lambda n:lookup(self.users,n),getpwall=lambda:list(self.users.values()))}))
        self.stack.enter_context(patch.object(admin.sys,'platform','linux'))
        self.stack.enter_context(patch.object(admin.os,'geteuid',return_value=0,create=True))
        self.stack.enter_context(patch.object(admin.os,'chown',create=True))
        self.stack.enter_context(patch.object(admin.shutil,'which',side_effect=lambda n:n))
        self.stack.enter_context(patch.object(admin,'root_directory',return_value=self.root))
        self.stack.enter_context(patch.object(admin,'actual_state',side_effect=copy.deepcopy))
        self.stack.enter_context(patch.object(admin,'member_access_ready',side_effect=lambda root,state: bool(state.get('sftpConfigured')) and state.get('storageVersion') == 1))
        self.stack.enter_context(patch.object(admin,'run',side_effect=self.command))
        admin.save(self.root, {'version':1,'teamId':'test','initialized':True,'loginGroup':'wb_test_members','users':{},'groups':{},'sftpConfigured':True,'storageVersion':1})

    def command(self, args, data=None, allowed=(0,)):
        self.calls.append(args)
        self.inputs.append((args, data))
        if self.fail and self.fail(args): raise RuntimeError('injected command failure')
        if args[0]=='groupadd':
            name=args[-1]; gid=int(args[args.index('-g')+1]); self.groups[name]=types.SimpleNamespace(gr_name=name,gr_gid=gid,gr_mem=[])
        if args[0]=='useradd':
            name=args[-1]; self.users[name]=types.SimpleNamespace(pw_uid=int(args[args.index('-u')+1]),pw_gid=self.groups[args[args.index('-g')+1]].gr_gid,pw_gecos=args[args.index('-c')+1])
        if args[0]=='usermod' and '-G' in args:
            for name in args[args.index('-G')+1].split(','):
                if args[-1] not in self.groups[name].gr_mem: self.groups[name].gr_mem.append(args[-1])
        if args[0]=='gpasswd': self.groups[args[-1]].gr_mem.remove(args[2])
        return ''

    def execute(self, op, **kwargs):
        return admin.execute({'root':'/srv/teamspace','op':op,**kwargs})

    def test_explicit_worker_upgrade_preserves_members_and_does_not_force_reconnect(self):
        before = admin.load(self.root)
        with patch.object(admin, 'install_content_worker') as install:
            result = self.execute('storage_upgrade')
            install.assert_called_once()
            self.assertFalse(install.call_args.kwargs['reconnect'])
        self.assertEqual(result['state']['users'], before['users'])
        self.assertEqual(result['state']['groups'], before['groups'])
        self.assertTrue(all(job['status'] == 'done' for job in result['state']['operations'].values()))

    def test_group_second_command_failure_recovers_without_duplicate_creation(self):
        self.fail=lambda a:a[0]=='groupadd' and a[-1].endswith('_admin')
        with self.assertRaises(RuntimeError): self.execute('group_create',label='ocr')
        state=admin.load(self.root); job=state['operations']['group_create:ocr']
        self.assertEqual(job['status'],'failed'); self.assertEqual(job['completed'],['成员用户组已创建'])
        self.assertIn('wb_test_ocr',self.groups)
        self.fail=None
        self.execute('recover',operationId=job['id'])
        state=admin.load(self.root)
        self.assertEqual(state['operations'][job['id']]['status'],'done')
        self.assertEqual(state['groups']['wb_test_ocr']['workspace'],'/projects/ocr')
        self.assertEqual(sum(a[0]=='groupadd' and a[-1]=='wb_test_ocr' for a in self.calls),1)

    def test_acl_failure_recovers_and_preserves_unrelated_existing_files(self):
        self.fail=lambda a:a[0]=='setfacl'
        with self.assertRaises(RuntimeError): self.execute('group_create',label='ocr')
        self.assertTrue((self.root/'projects/ocr').exists())
        self.fail=None; self.execute('recover',operationId='group_create:ocr')
        self.assertEqual(admin.load(self.root)['operations']['group_create:ocr']['status'],'done')
        self.assertEqual(sum(a[0]=='groupadd' for a in self.calls),2)
        (self.root/'projects/old').mkdir(); (self.root/'projects/old/keep.txt').write_text('keep')
        with self.assertRaisesRegex(ValueError,'非空'): self.execute('group_create',label='old')
        self.assertEqual((self.root/'projects/old/keep.txt').read_text(),'keep')

    def test_chinese_group_name_creates_derived_linux_group_and_workspace(self):
        self.execute('group_create', label='实体抽取')
        slug = admin.group_slug('实体抽取'); name = 'wb_test_' + slug
        state = admin.load(self.root)
        self.assertEqual(list(state['groups']), [name])
        self.assertEqual(state['groups'][name]['label'], '实体抽取')
        self.assertEqual(state['groups'][name]['workspace'], '/projects/实体抽取')
        self.assertTrue((self.root/'projects/实体抽取').is_dir())
        self.assertIn(name, self.groups); self.assertIn(name + '_admin', self.groups)
        self.assertRegex(name, r'^wb_test_g[a-f0-9]{13}$')
        with self.assertRaisesRegex(ValueError, '已经完成'): self.execute('group_create', label='实体抽取')

    def test_chinese_group_recovers_from_partial_failure_under_its_own_journal_key(self):
        self.fail = lambda a: a[0] == 'groupadd' and a[-1].endswith('_admin')
        with self.assertRaises(RuntimeError): self.execute('group_create', label='财务组')
        state = admin.load(self.root); job = state['operations']['group_create:财务组']
        self.assertEqual(job['status'], 'failed'); self.assertEqual(job['completed'], ['成员用户组已创建'])
        self.fail = None
        self.execute('recover', operationId=job['id'])
        state = admin.load(self.root)
        self.assertEqual(state['operations'][job['id']]['status'], 'done')
        self.assertEqual(state['groups']['wb_test_' + admin.group_slug('财务组')]['workspace'], '/projects/财务组')
        self.assertEqual(sum(a[0] == 'groupadd' and a[-1] == 'wb_test_' + admin.group_slug('财务组') for a in self.calls), 1)

    def test_group_names_that_differ_only_by_case_or_derived_name_are_rejected(self):
        self.execute('group_create', label='ocr')
        with self.assertRaisesRegex(ValueError, '仅大小写不同'): self.execute('group_create', label='OCR')
        self.execute('group_create', label='实体抽取')
        # A legacy-looking name that happens to collide with a derived Linux name must not take over that record.
        clash = 'g' + admin.hashlib.sha256('实体抽取'.encode('utf-8')).hexdigest()[:13]
        with self.assertRaisesRegex(ValueError, '冲突'): self.execute('group_create', label=clash)
        self.assertEqual(admin.load(self.root)['groups']['wb_test_' + admin.group_slug('实体抽取')]['label'], '实体抽取')

    def test_gid_replacement_is_rejected_and_foreign_group_is_not_adopted(self):
        self.fail=lambda a:a[0]=='groupadd' and a[-1].endswith('_admin')
        with self.assertRaises(RuntimeError): self.execute('group_create',label='ocr')
        self.fail=None; self.groups['wb_test_ocr'].gr_gid=9876
        with self.assertRaisesRegex(ValueError,'GID'): self.execute('recover',operationId='group_create:ocr')
        self.groups['wb_test_foreign']=types.SimpleNamespace(gr_name='wb_test_foreign',gr_gid=1234,gr_mem=[])
        with self.assertRaisesRegex(ValueError,'不能接管'): self.execute('group_create',label='foreign')

    def test_command_completed_before_connection_failure_is_recognized_on_retry(self):
        original = self.command
        once = [True]
        def interrupted(args, data=None, allowed=(0,)):
            result = original(args, data, allowed)
            if args[0] == 'groupadd' and once[0]:
                once[0] = False
                raise RuntimeError('connection lost after command completed')
            return result
        with patch.object(admin, 'run', side_effect=interrupted):
            with self.assertRaises(RuntimeError): self.execute('group_create',label='ocr')
            self.execute('recover',operationId='group_create:ocr')
        self.assertEqual(sum(a[0]=='groupadd' and a[-1]=='wb_test_ocr' for a in self.calls),1)
        self.assertEqual(admin.load(self.root)['operations']['group_create:ocr']['status'],'done')

    def test_password_failure_has_resumable_account_without_persisting_password(self):
        self.execute('group_create',label='ocr')
        self.fail=lambda a:a[0]=='chpasswd'
        with self.assertRaises(RuntimeError): self.execute('user_create',username='alice',name='Alice',password='sensitive-secret',groups=['wb_test_ocr'],contentAdminGroups=['wb_test_ocr'])
        state=admin.load(self.root)
        self.assertTrue(state['users']['alice']['provisioning'])
        self.assertNotIn('sensitive-secret',(self.root/'.workbench/admin/state.json').read_text(encoding='utf-8'))
        self.fail=None
        with self.assertRaisesRegex(ValueError,'重新输入'): self.execute('recover',operationId='user_create:alice')
        self.execute('recover',operationId='user_create:alice',password='replacement-secret')
        state=admin.load(self.root)
        self.assertFalse(state['users']['alice']['provisioning'])
        self.assertEqual(state['users']['alice']['contentAdminGroups'],['wb_test_ocr'])
        self.assertEqual(sum(a[0]=='useradd' for a in self.calls),1)
        self.assertNotIn('replacement-secret',(self.root/'.workbench/admin/state.json').read_text(encoding='utf-8'))

    def test_uid_replacement_during_recovery_is_rejected(self):
        self.fail=lambda a:a[0]=='chpasswd'
        with self.assertRaises(RuntimeError): self.execute('user_create',username='alice',name='Alice',password='test-password')
        self.fail=None; self.users['alice'].pw_uid=5555
        with self.assertRaisesRegex(ValueError,'身份'): self.execute('recover',operationId='user_create:alice',password='test-password')

    def test_member_group_partial_failure_can_be_reapplied(self):
        self.execute('group_create',label='ocr'); self.execute('user_create',username='alice',name='Alice',password='test-password')
        self.fail=lambda a:a[0]=='pkill'
        with self.assertRaises(RuntimeError): self.execute('user_groups',username='alice',groups=['wb_test_ocr'],contentAdminGroups=['wb_test_ocr'])
        self.fail=None; self.execute('recover',operationId='user_groups:alice')
        state=admin.load(self.root)
        self.assertEqual(state['operations']['user_groups:alice']['status'],'done')
        self.assertEqual(self.groups['wb_test_ocr_admin'].gr_mem,['alice'])

    def test_bootstrap_failure_before_registry_has_recovery_record(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            base=pathlib.Path(temp); root=base/'team'; journal=base/'bootstrap.json'
            # Inject failure immediately after the durable reservation, before directories.
            original=pathlib.Path.mkdir
            def mkdir(p,*args,**kwargs):
                if p==root: raise OSError('injected mkdir failure')
                return original(p,*args,**kwargs)
            with patch.object(admin,'bootstrap_file',return_value=journal), patch.object(pathlib.Path,'mkdir',mkdir):
                with self.assertRaises(OSError): admin.initialize(root,{})
            self.assertTrue(journal.exists())
            import json
            reservation=json.loads(journal.read_text(encoding='utf-8'))
            self.assertEqual(reservation['root'],str(root)); self.assertFalse(reservation['initialized'])
            self.assertNotIn('password',reservation)
            original_stat=pathlib.Path.stat
            def safe_stat(p,*args,**kwargs):
                info=original_stat(p,*args,**kwargs)
                if p==root or p in root.parents:
                    values=list(info); values[0]=0o40755; values[4]=0
                    return admin.os.stat_result(values)
                return info
            with patch.object(admin,'bootstrap_file',return_value=journal), patch.object(pathlib.Path,'stat',safe_stat), patch.object(admin,'configure_member_access') as access:
                restored=admin.initialize(root,{})
            self.assertTrue(restored['initialized'])
            self.assertFalse(restored['sftpConfigured']); self.assertNotIn('storageVersion',restored)
            access.assert_not_called()
            self.assertEqual(restored['teamId'],reservation['teamId'])
            self.assertFalse(journal.exists())

    def test_bootstrap_failure_after_directories_resumes_existing_registry(self):
        # The initial registry was persisted before groupadd failed. The root is now nonempty.
        import json
        state=admin.load(self.root); state['initialized']=False; state['loginGid']=1000
        admin.save(self.root,state)
        journal=self.root.parent/(self.root.name+'-bootstrap.json'); journal.write_text(json.dumps({**state,'root':str(self.root)}))
        self.addCleanup(lambda:journal.unlink(missing_ok=True))
        original=pathlib.Path.stat
        def stat(p,*args,**kwargs):
            info=original(p,*args,**kwargs)
            if p==self.root or p in self.root.parents:
                values=list(info); values[0]=0o40755; values[4]=0
                return admin.os.stat_result(values)
            return info
        with patch.object(admin,'bootstrap_file',return_value=journal), patch.object(pathlib.Path,'stat',stat), patch.object(admin,'configure_member_access') as access:
            state=admin.initialize(self.root,{})
        self.assertTrue(state['initialized']); self.assertFalse(journal.exists())
        self.assertTrue(state['sftpConfigured']); self.assertEqual(state['storageVersion'],1)
        access.assert_not_called()
        self.assertEqual(state['operations']['initialize']['status'],'done')

    def test_user_creation_configures_member_access_in_the_same_operation(self):
        state=admin.load(self.root); state['sftpConfigured']=False; state['storageVersion']=0; admin.save(self.root,state)
        def configure(root, current):
            current['sftpConfigured']=True; current['storageVersion']=1
        with patch.object(admin,'configure_member_access',side_effect=configure) as access:
            self.execute('user_create',username='alice',name='Alice',password='1')
        created=admin.load(self.root)
        self.assertTrue(created['sftpConfigured']); self.assertEqual(created['storageVersion'],1)
        self.assertFalse(created['users']['alice']['provisioning'])
        self.assertIn('成员登录能力已配置',created['operations']['user_create:alice']['completed'])
        access.assert_called_once_with(self.root,unittest.mock.ANY)

    def test_failed_container_worker_start_can_recover_user_creation_without_duplicates(self):
        state = admin.load(self.root); state['sftpConfigured'] = False; state['storageVersion'] = 0; admin.save(self.root, state)
        with patch.object(admin, 'configure_member_access', side_effect=RuntimeError('Supervisor start failed')):
            with self.assertRaisesRegex(RuntimeError, 'Supervisor start failed'):
                self.execute('user_create', username='alice', name='Alice', password='1')
        failed = admin.load(self.root)
        self.assertEqual(failed['operations']['user_create:alice']['status'], 'failed')
        self.assertFalse(failed['sftpConfigured']); self.assertEqual(failed['storageVersion'], 0)
        self.assertNotIn('alice', self.users)
        def recovered(root, current):
            current['sftpConfigured'] = True; current['storageVersion'] = 1
        with patch.object(admin, 'configure_member_access', side_effect=recovered):
            self.execute('recover', operationId='user_create:alice', password='1')
        result = admin.load(self.root)
        self.assertEqual(result['operations']['user_create:alice']['status'], 'done')
        self.assertFalse(result['users']['alice']['provisioning'])
        self.assertEqual(sum(call[0] == 'useradd' for call in self.calls), 1)

    def test_stale_member_access_flag_is_rejected_when_ssh_rule_is_missing_or_changed(self):
        state=admin.load(self.root)
        config=self.root/'member-access.conf'
        with patch.object(admin,'member_access_file',return_value=config), patch.object(admin,'sshd_includes_member_access',return_value=True):
            self.assertFalse(self.member_access_ready(self.root,state))
            config.write_text('stale rule\n',encoding='utf-8')
            self.assertFalse(self.member_access_ready(self.root,state))
            config.write_text(admin.member_access_config(self.root,state),encoding='utf-8')
            self.assertTrue(self.member_access_ready(self.root,state))

    def test_member_access_requires_an_active_global_sshd_include(self):
        config=self.root/'sshd_config'
        member=pathlib.Path('/etc/ssh/sshd_config.d/80-workbench-test.conf')
        for text in [
            '# Include /etc/ssh/sshd_config.d/*.conf\n',
            'Match User root\n    Include /etc/ssh/sshd_config.d/*.conf\n',
            'Include /etc/ssh/other.d/*.conf\n',
        ]:
            config.write_text(text,encoding='utf-8')
            self.assertFalse(admin.sshd_includes_member_access(member,config))
        config.write_text('Match User root\nMatch all\nInclude "/etc/ssh/sshd_config.d/*.conf" # managed drop-ins\n',encoding='utf-8')
        self.assertTrue(admin.sshd_includes_member_access(member,config))

    def test_member_creation_can_enable_a_missing_global_sshd_include(self):
        config=self.root/'sshd_config'
        member=pathlib.Path('/etc/ssh/sshd_config.d/80-workbench-test.conf')
        original='#Include /etc/ssh/sshd_config.d/*.conf\nMatch User root\n    PermitTTY no\n'
        config.write_text(original,encoding='utf-8')
        previous=admin.enable_member_access_include(member,config)
        self.assertEqual(previous,original)
        self.assertTrue(admin.sshd_includes_member_access(member,config))
        self.assertTrue(config.read_text(encoding='utf-8').startswith('Include /etc/ssh/sshd_config.d/*.conf\n'))

    def test_membership_manifest_has_no_offline_validity_field(self):
        self.execute('status')
        import json
        roles=json.loads((self.root/'.workbench/roles.json').read_text(encoding='utf-8'))
        self.assertNotIn('offlineHours',roles)
        with self.assertRaises(ValueError): self.execute('offline_policy', hours=4)


    def test_last_admin_requires_explicit_handoff_or_vacancy(self):
        self.execute('group_create',label='ocr')
        for username in ['alice','bob']:
            self.execute('user_create',username=username,name=username,password='1',groups=['wb_test_ocr'],contentAdminGroups=['wb_test_ocr'] if username=='alice' else [])
        with self.assertRaisesRegex(ValueError,'最后'):
            self.execute('group_member',username='alice',group='wb_test_ocr',role='member')
        self.execute('group_member',username='alice',group='wb_test_ocr',role='member',handoffs={'wb_test_ocr':'bob'})
        self.assertIn('bob',self.groups['wb_test_ocr_admin'].gr_mem)
        self.assertNotIn('alice',self.groups['wb_test_ocr_admin'].gr_mem)
        with self.assertRaisesRegex(ValueError,'最后'):
            self.execute('user_enabled',username='bob',enabled=False)
        self.execute('user_enabled',username='bob',enabled=False,handoffs={'wb_test_ocr':None})

if __name__ == '__main__': unittest.main()
