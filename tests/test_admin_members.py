import contextlib
import copy
import importlib.util
import json
import pathlib
import tempfile
import types
import sys
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('member_admin', pathlib.Path(__file__).parents[1] / 'server/admin.py')
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)


class MemberProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        (self.root / '.workbench/admin').mkdir(parents=True)
        self.state = dict(initialized=True, teamId='team-a', users=dict(alice=dict(username='alice', name='Alice', enabled=True, uid=1001, groups=[], contentAdminGroups=[])), groups={})
        self.write(self.state)
        stack = self.enterContext(contextlib.ExitStack())
        stack.enter_context(patch.object(admin, 'actual_state', side_effect=copy.deepcopy))
        stack.enter_context(patch.object(admin, 'root_directory', return_value=self.root))
        stack.enter_context(patch.object(admin, 'write_roles'))
        stack.enter_context(patch.object(admin, 'ensure_user'))
        stack.enter_context(patch.object(admin, 'acl_backend', return_value='setfacl'))
        stack.enter_context(patch.object(admin.shutil, 'which', side_effect=lambda name: name))
        stack.enter_context(patch.object(admin.sys, 'platform', 'linux'))
        stack.enter_context(patch.object(admin.os, 'geteuid', return_value=0, create=True))
        self.run = stack.enter_context(patch.object(admin, 'run', return_value=''))

    def write(self, state):
        admin.atomic_json(self.root / '.workbench/admin/state.json', state)

    def request(self, command):
        return dict(op='members_apply', root='/srv/teamspace', teamId='team-a', requestId=str(uuid.uuid4()), command=command)

    def command(self, op='user_enabled', **kwargs):
        user = admin.member_public_state(admin.load(self.root))['users']['alice']
        return dict(op=op, username='alice', expectedRevision=user['revision'], **kwargs)

    def test_full_then_delta_and_tombstones(self):
        first = admin.member_protocol(self.root, dict(op='members_sync'))
        self.assertTrue(first['full'])
        same = admin.member_protocol(self.root, dict(op='members_sync', teamId='team-a', since=first['sequence']))
        self.assertEqual(same['users'], {})
        self.assertNotIn('metadata', same)
        state = admin.load(self.root)
        state['users']['bob'] = dict(username='bob', name='Bob', enabled=True)
        del state['users']['alice']
        self.write(state)
        delta = admin.member_protocol(self.root, dict(op='members_sync', since=first['sequence']))
        self.assertEqual(list(delta['users']), ['bob'])
        self.assertEqual(delta['deletedUsers'], ['alice'])
        self.assertNotIn('memberIndex', json.dumps(delta))

    def test_team_mismatch_has_no_side_effects(self):
        request = self.request(self.command(enabled=False))
        request['teamId'] = 'team-b'
        before = admin.load(self.root)
        with self.assertRaisesRegex(ValueError, 'MEMBER_TEAM'):
            admin.member_protocol(self.root, request)
        self.assertEqual(admin.load(self.root), before)
        self.run.assert_not_called()
        self.write({**before, 'operations': {'user_enabled:alice': dict(status='running', completed=[])}})
        protected = admin.load(self.root)
        with self.assertRaisesRegex(ValueError, 'MEMBER_TEAM'):
            admin.execute(dict(op='user_enabled', root='/srv/teamspace', username='alice', enabled=False, expectedTeamId='team-b'))
        self.assertEqual(admin.load(self.root), protected)

    def test_completed_request_is_durable_and_duplicate_does_not_rerun(self):
        request = self.request(self.command(enabled=False))
        admin.member_protocol(self.root, request)
        count = self.run.call_count
        self.assertGreater(count, 0)
        result = admin.member_protocol(self.root, request)
        self.assertTrue(result['duplicate'])
        self.assertEqual(self.run.call_count, count)
        self.assertNotIn('memberRequests', result['state'])
        changed = copy.deepcopy(request)
        changed['command']['enabled'] = True
        with self.assertRaisesRegex(ValueError, 'MEMBER_REQUEST'):
            admin.member_protocol(self.root, changed)

    def test_password_revision_blocks_stale_edit_without_logging_secret(self):
        old = self.command(enabled=False)
        request = self.request(self.command('user_password', password='secret-password'))
        admin.member_protocol(self.root, request)
        changed = copy.deepcopy(request)
        changed['command']['password'] = 'different-password'
        with self.assertRaisesRegex(ValueError, 'MEMBER_REQUEST'):
            admin.member_protocol(self.root, changed)
        with self.assertRaisesRegex(ValueError, 'MEMBER_CONFLICT'):
            admin.member_protocol(self.root, self.request(old))
        self.assertNotIn('secret-password', json.dumps(admin.load(self.root)))
        self.assertNotIn('secret-password', (self.root / '.workbench/admin/audit.jsonl').read_text())

    def test_partial_failure_requires_explicit_recovery_and_preserves_both_receipts(self):
        request = self.request(self.command(enabled=False))
        self.run.side_effect = RuntimeError('injected system failure')
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            admin.member_protocol(self.root, request)
        self.run.side_effect = None
        with self.assertRaisesRegex(ValueError, 'MEMBER_RECOVERY'):
            admin.member_protocol(self.root, request)
        recovery = self.request(self.command('recover', operationId='member:' + request['requestId']))
        admin.member_protocol(self.root, recovery)
        state = admin.load(self.root)
        self.assertEqual(state['memberRequests'][request['requestId']]['status'], 'done')
        self.assertEqual(state['memberRequests'][recovery['requestId']]['status'], 'done')
        self.assertTrue(admin.member_protocol(self.root, request)['duplicate'])

    def test_create_cannot_adopt_another_request_partial_account_or_case_alias(self):
        state = admin.load(self.root)
        state['users']['alice']['provisioning'] = True
        self.write(state)
        for name in ['alice', 'Alice']:
            request = self.request(dict(op='user_create', username=name, name='Other', groups=[], contentAdminGroups=[]))
            with self.assertRaisesRegex(ValueError, 'MEMBER_EXISTS'):
                admin.member_protocol(self.root, request)
        self.run.assert_not_called()

    def test_delta_membership_updates_keep_other_groups(self):
        state = admin.load(self.root)
        state['groups'] = {name: dict(name=name, workspace='/projects/' + name) for name in ['one', 'two']}
        state['users']['alice']['groups'] = ['one']
        command = dict(op='member_groups', username='alice', expectedRevision=admin.member_public_state(state)['users']['alice']['revision'], changes=[dict(group='two', role='member')])
        prepared = admin.prepare_member_operation(state, copy.deepcopy(state), self.request(command))
        self.assertEqual(prepared['groups'], ['one', 'two'])
        self.assertEqual(prepared['op'], 'user_groups')

    def test_import_existing_team_account_preserves_password_and_os_roles(self):
        state = admin.load(self.root)
        state['teamId'] = '322ec820'
        state['loginGroup'] = 'wb_322ec820_members'
        group = 'wb_322ec820_project'
        state['groups'] = {group: dict(name=group, label='项目甲', workspace='/projects/项目甲', adminGroup=group + '_admin')}
        old_id = str(uuid.uuid4())
        state['operations'] = {'user_create:taowen': dict(id='user_create:taowen', op='user_create', request={'username': 'taowen'}, status='failed', completed=[], error='Linux 账号已存在，工具不会接管已有系统账号'), 'member:' + old_id: dict(id='member:' + old_id, op='user_create', request={'username': 'taowen', 'requestId': old_id}, status='failed', completed=[], error='Linux 账号已存在，工具不会接管已有系统账号')}
        state['memberRequests'] = {old_id: dict(signature='old', status='failed')}
        self.write(state)
        account = types.SimpleNamespace(pw_uid=1000, pw_gid=1000, pw_gecos='workbench-322ec820-taowen', pw_dir='/', pw_shell='/usr/sbin/nologin')
        groups = [types.SimpleNamespace(gr_name='wb_322ec820_members', gr_gid=1000, gr_mem=[]), types.SimpleNamespace(gr_name=group, gr_gid=1001, gr_mem=['taowen']), types.SimpleNamespace(gr_name=group + '_admin', gr_gid=1002, gr_mem=['taowen'])]
        with patch.dict(sys.modules, {'pwd': types.SimpleNamespace(getpwnam=lambda name: account), 'grp': types.SimpleNamespace(getgrnam=lambda name: groups[0], getgrall=lambda: groups)}), patch.object(admin, 'verify_existing_password') as verify:
            inspected = admin.existing_member(self.root, state, 'taowen')
            self.assertEqual(inspected['groups'], [group])
            self.assertEqual(inspected['contentAdminGroups'], [group])
            command = dict(op='user_import', username='taowen', name='陶文', password='original-secret', expectedIdentity=inspected['identity'])
            request = dict(op='members_apply', root='/srv/teamspace', teamId='322ec820', requestId=str(uuid.uuid4()), command=command)
            admin.member_protocol(self.root, request)
            verify.assert_called_with('taowen', 'original-secret')
            final = admin.load(self.root)
            self.assertEqual(final['users']['taowen']['uid'], 1000)
            self.assertEqual(final['users']['taowen']['marker'], account.pw_gecos)
            self.assertEqual(final['users']['taowen']['contentAdminGroups'], [group])
            self.assertEqual(final['operations']['user_create:taowen']['status'], 'done')
            self.assertEqual(final['operations']['member:' + old_id]['status'], 'done')
            self.assertEqual(final['memberRequests'][old_id]['status'], 'done')
            self.assertNotIn('original-secret', json.dumps(final))
            self.assertNotIn('original-secret', (self.root / '.workbench/admin/audit.jsonl').read_text())
            synced = admin.member_protocol(self.root, dict(op='members_sync', requestIds=[old_id]))
            self.assertEqual(synced['users']['taowen']['groups'], [group])
            self.assertEqual(synced['users']['taowen']['contentAdminGroups'], [group])
            self.assertEqual(synced['receipts'][old_id], 'done')
            self.run.assert_not_called()

    def test_import_legacy_account_from_same_linux_system_adds_current_login_group(self):
        state = admin.load(self.root)
        state['teamId'] = 'fee5fb2d'
        state['loginGroup'] = 'wb_fee5fb2d_members'
        self.write(state)
        account = types.SimpleNamespace(pw_uid=1000, pw_gid=1000, pw_gecos='workbench-322ec820-taowen', pw_dir='/', pw_shell='/usr/sbin/nologin')
        old = types.SimpleNamespace(gr_name='wb_322ec820_members', gr_gid=1000, gr_mem=[])
        project = types.SimpleNamespace(gr_name='wb_322ec820_ge486418df7448', gr_gid=1001, gr_mem=['taowen'])
        admin_group = types.SimpleNamespace(gr_name=project.gr_name + '_admin', gr_gid=1002, gr_mem=['taowen'])
        current = types.SimpleNamespace(gr_name='wb_fee5fb2d_members', gr_gid=1003, gr_mem=[])
        groups = [old, project, admin_group, current]
        def run(args, data=None, allowed=(0,)):
            if args[:3] == ['usermod', '-a', '-G']:
                current.gr_mem.append('taowen')
            return ''
        with patch.dict(sys.modules, {'pwd': types.SimpleNamespace(getpwnam=lambda name: account), 'grp': types.SimpleNamespace(getgrnam=lambda name: current, getgrall=lambda: groups)}), patch.object(admin, 'verify_existing_password') as verify, patch.object(admin, 'member_access_ready', return_value=True), patch.object(admin, 'effective_member_chroot', side_effect=[None, str(self.root)]) as chroot:
            self.run.side_effect = run
            inspected = admin.existing_member(self.root, state, 'taowen')
            self.assertEqual(inspected['historicalGroups'], sorted([old.gr_name, project.gr_name, admin_group.gr_name]))
            self.assertEqual(inspected['unknownGroups'], [])
            self.assertTrue(inspected['needsLoginGroup'])
            request = dict(op='members_apply', root='/srv/teamspace', teamId=state['teamId'], requestId=str(uuid.uuid4()), command=dict(op='user_import', username='taowen', name='陶文', password='original-secret', expectedIdentity=inspected['identity']))
            admin.member_protocol(self.root, request)
            verify.assert_called_with('taowen', 'original-secret')
            self.assertEqual(chroot.call_count, 2)
            self.run.assert_any_call(['usermod', '-a', '-G', current.gr_name, 'taowen'])
            final = admin.load(self.root)['users']['taowen']
            self.assertEqual(final['marker'], account.pw_gecos)
            self.assertEqual(final['groups'], [])
            self.assertIn('taowen', current.gr_mem)

    def test_import_refuses_other_active_sftp_root_without_changing_groups(self):
        state = admin.load(self.root)
        state['teamId'] = 'fee5fb2d'
        state['loginGroup'] = 'wb_fee5fb2d_members'
        self.write(state)
        account = types.SimpleNamespace(pw_uid=1000, pw_gid=1000, pw_gecos='workbench-322ec820-taowen', pw_dir='/', pw_shell='/usr/sbin/nologin')
        old = types.SimpleNamespace(gr_name='wb_322ec820_members', gr_gid=1000, gr_mem=[])
        current = types.SimpleNamespace(gr_name='wb_fee5fb2d_members', gr_gid=1003, gr_mem=[])
        with patch.dict(sys.modules, {'pwd': types.SimpleNamespace(getpwnam=lambda name: account), 'grp': types.SimpleNamespace(getgrnam=lambda name: current, getgrall=lambda: [old, current])}), patch.object(admin, 'verify_existing_password'), patch.object(admin, 'effective_member_chroot', return_value='/srv/other-space'):
            inspected = admin.existing_member(self.root, state, 'taowen')
            request = dict(op='members_apply', root='/srv/teamspace', teamId=state['teamId'], requestId=str(uuid.uuid4()), command=dict(op='user_import', username='taowen', name='陶文', password='original-secret', expectedIdentity=inspected['identity']))
            with self.assertRaisesRegex(ValueError, '另一团队空间'):
                admin.member_protocol(self.root, request)
            self.assertNotIn('taowen', admin.load(self.root)['users'])
            self.run.assert_not_called()

    def test_import_retry_after_login_group_added_keeps_original_identity(self):
        state = admin.load(self.root)
        state['teamId'] = 'fee5fb2d'
        state['loginGroup'] = 'wb_fee5fb2d_members'
        self.write(state)
        account = types.SimpleNamespace(pw_uid=1000, pw_gid=1000, pw_gecos='workbench-322ec820-taowen', pw_dir='/', pw_shell='/usr/sbin/nologin')
        old = types.SimpleNamespace(gr_name='wb_322ec820_members', gr_gid=1000, gr_mem=[])
        current = types.SimpleNamespace(gr_name='wb_fee5fb2d_members', gr_gid=1003, gr_mem=[])
        groups = [old, current]
        def run(args, data=None, allowed=(0,)):
            if args[:3] == ['usermod', '-a', '-G']:
                current.gr_mem.append('taowen')
            return ''
        with patch.dict(sys.modules, {'pwd': types.SimpleNamespace(getpwnam=lambda name: account), 'grp': types.SimpleNamespace(getgrnam=lambda name: current, getgrall=lambda: groups)}), patch.object(admin, 'verify_existing_password'), patch.object(admin, 'member_access_ready', return_value=True), patch.object(admin, 'effective_member_chroot', side_effect=[None, str(self.root), str(self.root), str(self.root)]):
            self.run.side_effect = run
            inspected = admin.existing_member(self.root, state, 'taowen')
            request = dict(op='members_apply', root='/srv/teamspace', teamId=state['teamId'], requestId=str(uuid.uuid4()), command=dict(op='user_import', username='taowen', name='陶文', password='original-secret', expectedIdentity=inspected['identity']))
            with patch.object(admin, 'write_roles', side_effect=[None, RuntimeError('publish failed'), None]):
                with self.assertRaisesRegex(RuntimeError, 'publish failed'):
                    admin.member_protocol(self.root, request)
            self.assertIn('taowen', current.gr_mem)
            self.assertEqual(admin.existing_member(self.root, admin.load(self.root), 'taowen')['identity'], inspected['identity'])
            recovery = self.request(dict(op='recover', username='taowen', operationId='member:' + request['requestId'], expectedRevision='absent', password='original-secret'))
            recovery['teamId'] = state['teamId']
            admin.member_protocol(self.root, recovery)
            self.assertEqual(admin.load(self.root)['users']['taowen']['uid'], 1000)
            self.assertEqual(self.run.call_count, 1)

    def test_import_rolls_back_login_group_if_ssh_routes_elsewhere_after_join(self):
        state = admin.load(self.root)
        state['teamId'] = 'fee5fb2d'
        state['loginGroup'] = 'wb_fee5fb2d_members'
        self.write(state)
        account = types.SimpleNamespace(pw_uid=1000, pw_gid=1000, pw_gecos='workbench-322ec820-taowen', pw_dir='/', pw_shell='/usr/sbin/nologin')
        old = types.SimpleNamespace(gr_name='wb_322ec820_members', gr_gid=1000, gr_mem=[])
        current = types.SimpleNamespace(gr_name='wb_fee5fb2d_members', gr_gid=1003, gr_mem=[])
        def run(args, data=None, allowed=(0,)):
            if args[:3] == ['usermod', '-a', '-G']:
                current.gr_mem.append('taowen')
            if args[:2] == ['gpasswd', '-d']:
                current.gr_mem.remove('taowen')
            return ''
        with patch.dict(sys.modules, {'pwd': types.SimpleNamespace(getpwnam=lambda name: account), 'grp': types.SimpleNamespace(getgrnam=lambda name: current, getgrall=lambda: [old, current])}), patch.object(admin, 'verify_existing_password'), patch.object(admin, 'member_access_ready', return_value=True), patch.object(admin, 'effective_member_chroot', side_effect=[None, '/srv/wrong-root']):
            self.run.side_effect = run
            inspected = admin.existing_member(self.root, state, 'taowen')
            request = dict(op='members_apply', root='/srv/teamspace', teamId=state['teamId'], requestId=str(uuid.uuid4()), command=dict(op='user_import', username='taowen', name='陶文', password='original-secret', expectedIdentity=inspected['identity']))
            with self.assertRaisesRegex(ValueError, 'SFTP 目录与当前空间不符'):
                admin.member_protocol(self.root, request)
            self.assertNotIn('taowen', current.gr_mem)
            self.assertNotIn('taowen', admin.load(self.root)['users'])
            self.run.assert_any_call(['gpasswd', '-d', 'taowen', current.gr_name])

    def test_import_rejects_wrong_team_identity_and_wrong_password_without_registration(self):
        state = admin.load(self.root)
        state['loginGroup'] = 'wb_team-a_members'
        self.write(state)
        account = types.SimpleNamespace(pw_uid=1000, pw_gid=1000, pw_gecos='workbench-other-taowen', pw_dir='/', pw_shell='/usr/sbin/nologin')
        login_group = types.SimpleNamespace(gr_name='wb_team-a_members', gr_gid=1000, gr_mem=[])
        with patch.dict(sys.modules, {'pwd': types.SimpleNamespace(getpwnam=lambda name: account), 'grp': types.SimpleNamespace(getgrnam=lambda name: login_group, getgrall=lambda: [login_group])}):
            with self.assertRaisesRegex(ValueError, '不是本 Linux 系统'):
                admin.existing_member(self.root, state, 'taowen')
            account.pw_gecos = 'workbench-team-a-taowen'
            inspected = admin.existing_member(self.root, state, 'taowen')
            command = dict(op='user_import', username='taowen', name='陶文', password='wrong', expectedIdentity=inspected['identity'])
            request = self.request(command)
            with patch.object(admin, 'verify_existing_password', side_effect=ValueError('原密码不正确')):
                with self.assertRaisesRegex(ValueError, '原密码不正确'):
                    admin.member_protocol(self.root, request)
            self.assertNotIn('taowen', admin.load(self.root)['users'])
            self.assertNotIn('memberRequests', admin.load(self.root))
            self.assertNotIn('operations', admin.load(self.root))
            self.run.assert_not_called()

    def test_import_refuses_unregistered_linux_groups(self):
        state = admin.load(self.root)
        state['loginGroup'] = 'wb_team-a_members'
        self.write(state)
        account = types.SimpleNamespace(pw_uid=1000, pw_gid=1000, pw_gecos='workbench-team-a-taowen', pw_dir='/', pw_shell='/usr/sbin/nologin')
        login_group = types.SimpleNamespace(gr_name='wb_team-a_members', gr_gid=1000, gr_mem=[])
        extra_group = types.SimpleNamespace(gr_name='sudo', gr_gid=27, gr_mem=['taowen'])
        with patch.dict(sys.modules, {'pwd': types.SimpleNamespace(getpwnam=lambda name: account), 'grp': types.SimpleNamespace(getgrnam=lambda name: login_group, getgrall=lambda: [login_group, extra_group])}), patch.object(admin, 'verify_existing_password') as verify:
            inspected = admin.existing_member(self.root, state, 'taowen')
            self.assertEqual(inspected['unknownGroups'], ['sudo'])
            command = dict(op='user_import', username='taowen', name='陶文', password='original-secret', expectedIdentity=inspected['identity'])
            with self.assertRaisesRegex(ValueError, '未登记或已停用'):
                admin.member_protocol(self.root, self.request(command))
            verify.assert_not_called()
            self.assertNotIn('taowen', admin.load(self.root)['users'])

    def test_import_verifies_original_shadow_password_without_reset(self):
        class FakeCrypt:
            argtypes = None
            restype = None

            def __call__(self, password, salt):
                return salt if password == b'correct' else b'wrong-hash'

        with patch.object(pathlib.Path, 'read_text', return_value='taowen:$6$sample-hash:20000:0:99999:7:::\n'), patch('ctypes.util.find_library', return_value='libcrypt.so.1'), patch('ctypes.CDLL', return_value=types.SimpleNamespace(crypt=FakeCrypt())):
            admin.verify_existing_password('taowen', 'correct')
            with self.assertRaisesRegex(ValueError, '原密码不正确'):
                admin.verify_existing_password('taowen', 'incorrect')

    def test_import_recovers_after_registry_write_without_recreating_linux_user(self):
        state = admin.load(self.root)
        state['loginGroup'] = 'wb_team-a_members'
        self.write(state)
        account = types.SimpleNamespace(pw_uid=1000, pw_gid=1000, pw_gecos='workbench-team-a-taowen', pw_dir='/', pw_shell='/usr/sbin/nologin')
        login_group = types.SimpleNamespace(gr_name='wb_team-a_members', gr_gid=1000, gr_mem=[])
        with patch.dict(sys.modules, {'pwd': types.SimpleNamespace(getpwnam=lambda name: account), 'grp': types.SimpleNamespace(getgrnam=lambda name: login_group, getgrall=lambda: [login_group])}), patch.object(admin, 'verify_existing_password'):
            inspected = admin.existing_member(self.root, state, 'taowen')
            command = dict(op='user_import', username='taowen', name='陶文', password='original-secret', expectedIdentity=inspected['identity'])
            request = self.request(command)
            with patch.object(admin, 'write_roles', side_effect=[None, RuntimeError('publish failed'), None]):
                with self.assertRaisesRegex(RuntimeError, 'publish failed'):
                    admin.member_protocol(self.root, request)
            partial = admin.load(self.root)
            job_id = 'member:' + request['requestId']
            self.assertNotIn('taowen', partial['users'])
            self.assertEqual(partial['operations'][job_id]['status'], 'failed')
            recovery = self.request(dict(op='recover', username='taowen', operationId=job_id, expectedRevision='absent', password='original-secret'))
            admin.member_protocol(self.root, recovery)
            final = admin.load(self.root)
            self.assertEqual(final['operations'][job_id]['status'], 'done')
            self.assertEqual(final['memberRequests'][request['requestId']]['status'], 'done')
            self.assertEqual(final['users']['taowen']['uid'], 1000)
            self.run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
