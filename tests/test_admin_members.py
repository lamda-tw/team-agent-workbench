import contextlib
import copy
import importlib.util
import json
import pathlib
import tempfile
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


if __name__ == '__main__':
    unittest.main()
