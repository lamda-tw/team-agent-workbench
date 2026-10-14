"""Real worker business rules on disk; Linux-only case also tests kernel ACL denial.

Windows mocks ownership/chmod only. It is not a substitute for the Linux case.
"""
import copy
import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('content', pathlib.Path(__file__).parents[1] / 'server/content.py')
content = importlib.util.module_from_spec(spec)
spec.loader.exec_module(content)

BRIEF = dict(background='项目背景', objectives='提升质量', acceptance='指标验收')

class ContentRules(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        for folder in ['projects/relation', 'projects/ocr', '.workbench/admin']:
            (self.root / folder).mkdir(parents=True)
        self.state = {'users': {
            'alice': {'enabled': True, 'groups': ['relation', 'ocr'], 'contentAdminGroups': ['relation']},
            'bob': {'enabled': True, 'groups': ['relation', 'ocr'], 'contentAdminGroups': ['ocr']},
            'carol': {'enabled': True, 'groups': ['ocr'], 'contentAdminGroups': []}},
            'groups': {g: {'workspace': 'projects/' + g, 'gid': 100} for g in ['relation', 'ocr']}}
        for mock in [patch.object(content.os, 'chown', create=True), patch.object(content.os, 'chmod'), patch.object(content.shutil, 'which', return_value='setfacl'), patch.object(content.subprocess, 'run')]:
            mock.start(); self.addCleanup(mock.stop)
        self.project = self.call('alice', op='create_project', name='实体抽取', groupName='relation', brief=BRIEF)['projectId']
        self.directory = self.root / 'projects/relation/实体抽取'
        self.incoming = self.root / 'incoming.bin'; self.incoming.write_bytes(b'original')

    def call(self, actor, **request):
        return content.handle(self.root, self.state, actor, {'projectId': getattr(self, 'project', None), **request}, getattr(self, 'incoming', None))

    def publish(self, actor='bob', name='result.zip', kind='contribution'):
        return self.call(actor, op='publish', target='/projects/relation/实体抽取/submissions/' + actor + '/' + name, sha256=content.digest(self.incoming), metadata={'title': '方案结论', 'description': '已验证内容', 'kind': kind})

    def test_questions_member_scope_privacy_append_dedup_and_manual_close(self):
        # All API calls still go through handle's live account/project ACL checks.
        self.state['users']['carol']['groups'].append('relation')
        self.state['users']['dave'] = dict(enabled=True, groups=['relation'])
        command = dict(kind='create', id=str(uuid.uuid4()), sessionId=str(uuid.uuid4()), title='验收数据', body='使用哪个版本？', context='补充资料', recipients=['bob', 'carol'])
        def request(actor, cmd=None):
            return self.call(actor, op='question', command=cmd)
        q = request('alice', command)
        self.assertEqual(q['activityRevision'], 1)
        self.assertEqual(request('alice', command)['id'], q['id'])
        self.assertEqual(len(request('alice')), 1)
        self.assertEqual({m['username'] for m in request('bob', 'members')}, {'alice', 'carol', 'dave'})
        self.assertEqual(request('dave'), [])
        with self.assertRaises(PermissionError):
            request('bob', dict(kind='close', id=q['id']))
        run_ids, sessions = {}, {}
        for username in ('bob', 'carol'):
            sid, rid = str(uuid.uuid4()), str(uuid.uuid4())
            run_ids[username], sessions[username] = rid, sid
            request(username, dict(kind='link', id=q['id'], sessionId=sid))
            progress = request(username, dict(kind='run', id=q['id'], sessionId=sid, runId=rid))
            self.assertEqual(progress['activityRevision'], 1)
            with self.assertRaises(ValueError):
                request(username, dict(kind='run', id=q['id'], sessionId=sid, runId=str(uuid.uuid4())))
        for username in ('bob', 'carol'):
            request(username, dict(kind='reply', id=q['id'], runId=run_ids[username], body=username + ' answer'))
        all_answers = request('alice')[0]
        self.assertFalse(all_answers.get('closedAt'))
        self.assertEqual([len(r['answers']) for r in all_answers['recipients']], [1, 1])
        private = request('bob')[0]
        self.assertEqual(private['sessionId'], '')
        self.assertNotIn('carol answer', json.dumps(private))
        follow_id = str(uuid.uuid4())
        continued = request('alice', dict(kind='follow', id=q['id'], followId=follow_id, body='请改为 v3'))
        self.assertEqual(continued['followUps'][0]['body'], '请改为 v3')
        self.assertEqual(request('alice', dict(kind='follow', id=q['id'], followId=follow_id, body='请改为 v3'))['revision'], continued['revision'])
        self.assertEqual(request('bob')[0]['followUps'][0]['body'], '请改为 v3')
        with self.assertRaises(PermissionError):
            request('bob', dict(kind='follow', id=q['id'], followId=str(uuid.uuid4()), body='越权'))
        targeted = str(uuid.uuid4())
        request('alice', dict(kind='follow', id=q['id'], followId=targeted, body='只给 bob', target='bob'))
        self.assertNotIn('只给 bob', json.dumps(request('carol')[0]))
        self.assertEqual(request('bob')[0]['followUps'][-1]['body'], '只给 bob')
        suggested = request('bob', dict(kind='suggest', id=q['id'], username='bob'))
        self.assertFalse(suggested.get('closedAt'))
        self.assertTrue(suggested['recipients'][0].get('endSuggestedAt'))
        with self.assertRaises(PermissionError):
            request('carol', dict(kind='suggest', id=q['id'], username='bob'))
        resumed = request('alice', dict(kind='resume', id=q['id'], username='bob'))
        self.assertFalse(resumed['recipients'][0].get('endSuggestedAt'))
        half_id, half_session = str(uuid.uuid4()), str(uuid.uuid4())
        request('alice', dict(command, id=half_id, sessionId=half_session))
        request('bob', dict(kind='link', id=half_id, sessionId=str(uuid.uuid4())))
        self.assertTrue(request('bob', dict(kind='close', id=half_id)).get('closedAt'))
        closed = request('alice', dict(kind='close', id=q['id']))
        with self.assertRaises(ValueError):
            request('alice', dict(kind='follow', id=q['id'], followId=str(uuid.uuid4()), body='太晚'))
        self.assertTrue(closed['closedAt'])
        self.assertEqual(closed['activityRevision'], closed['revision'])
        self.assertEqual(closed['recipients'][0]['sessionId'], sessions['bob'])
        retry = request('bob', dict(kind='reply', id=q['id'], runId=run_ids['bob'], body='bob answer'))
        self.assertEqual(retry['revision'], closed['revision'])
        with self.assertRaises(ValueError):
            request('carol', dict(kind='reply', id=q['id'], runId=str(uuid.uuid4()), body='late reply'))
        self.state['users']['bob']['enabled'] = False
        with self.assertRaises(PermissionError):
            request('bob')

    def test_questions_reject_other_group_and_release_failed_answer_claim(self):
        command = dict(kind='create', id=str(uuid.uuid4()), sessionId=str(uuid.uuid4()), title='数据', body='版本？', recipients=['carol'])
        with self.assertRaises(ValueError):
            self.call('alice', op='question', command=command)
        command['recipients'] = ['bob']
        q = self.call('alice', op='question', command=command)
        with self.assertRaises(PermissionError):
            self.call('carol', op='question')
        sid, rid = str(uuid.uuid4()), str(uuid.uuid4())
        for cmd in [dict(kind='link', sessionId=sid), dict(kind='run', sessionId=sid, runId=rid), dict(kind='fail', runId=rid)]:
            result = self.call('bob', op='question', command=dict(id=q['id'], **cmd))
        self.assertEqual(result['recipients'][0]['state'], 'linked')
        self.assertEqual(result['activityRevision'], 1)
        result = self.call('bob', op='question', command=dict(kind='run', id=q['id'], sessionId=sid, runId=str(uuid.uuid4())))
        self.assertEqual(result['recipients'][0]['state'], 'running')

    def origin(self, actor='bob', **changes):
        value = dict(version=1, submittedBy=actor, submittedAt='2000-01-01T00:00:00Z', destination=dict(projectId=self.project, projectName='客户端旧名字', groupName='relation', groupLabel='客户端旧组名'), sources=[dict(kind='session', id=str(uuid.uuid4()), title='量化误差分析', capturedAt='2026-10-08T01:00:00Z', snapshotHash='a' * 64)])
        value.update(changes)
        return value

    def test_submission_canonical_actor_and_destination_reject_mismatch_before_file_write(self):
        target = '/projects/relation/实体抽取/submissions/bob/origin.md'
        meta = dict(kind='contribution', title='误差评估', description='对照评测', submission=self.origin())
        for wrong in [dict(meta['submission'], submittedBy='alice'), dict(meta['submission'], destination=dict(projectId=self.project, groupName='ocr')), dict(meta['submission'], sources=[dict(kind='team_result', id=str(uuid.uuid4()), version=1, projectId=self.project)])]:
            with self.assertRaises((PermissionError, ValueError)):
                self.call('bob', op='publish', target=target, sha256=content.digest(self.incoming), metadata=dict(meta, submission=wrong))
            self.assertFalse((self.directory / 'submissions/bob/origin.md').exists())
        item = self.call('bob', op='publish', target=target, sha256=content.digest(self.incoming), metadata=meta)
        record = item['submission']
        self.assertEqual(record['submittedBy'], 'bob')
        self.assertEqual(record['destination'], dict(projectId=self.project, projectName='实体抽取', groupName='relation', groupLabel='relation'))
        self.assertNotEqual(record['submittedAt'], meta['submission']['submittedAt'])
        self.assertEqual(record['sources'], meta['submission']['sources'])

    def test_submission_receipt_keeps_first_snapshot_on_retry_and_admin_edit(self):
        target = '/projects/relation/实体抽取/submissions/bob/origin.md'
        meta = dict(kind='contribution', title='误差评估', description='对照评测', submission=self.origin())
        item = self.call('bob', op='publish', target=target, sha256=content.digest(self.incoming), metadata=meta)
        first = copy.deepcopy(item['submission'])
        meta['submission']['sources'][0]['title'] = '后来更名'
        self.state['groups']['relation']['label'] = '新组名'
        again = self.call('bob', op='publish', target=target, sha256=content.digest(self.incoming), metadata=meta)
        self.assertEqual(again['submission'], first)
        updated = self.call('alice', op='edit_content', change=dict(id=item['id'], revision=1, action='save', title='管理员整理', description='补充证据', sourceSessionTitle='维护会话'))
        self.assertEqual(updated['submission'], first)
        self.assertEqual(updated['author'], 'bob')
        self.assertEqual(updated['updatedBy'], 'alice')
        self.call('alice', op='edit_content', change=dict(id=item['id'], revision=2, action='delete'))
        tombstone = content.read_json(self.directory / '.workbench-content-history.json')[0]
        self.assertEqual(tombstone['submission'], first)
        self.assertEqual(tombstone['deletedBy'], 'alice')

    def test_merged_submission_uses_exact_public_sources_instead_of_helper_session(self):
        sources = [self.publish(name=f'origin-{index}.zip') for index in range(2)]
        result = self.call('alice', op='merge_content', change=dict(sources=[dict(id=item['id'], revision=1) for item in sources], replaceIds=[], title='统一发现', description='整理依据', sourceSessionTitle='仅用于执行的会话'))
        self.assertEqual(result['submission']['submittedBy'], 'alice')
        self.assertEqual(result['submission']['sources'], [dict(kind='team_result', id=item['id'], version=1, projectId=self.project, title=item['title'], author='bob') for item in sources])
        self.assertNotIn('仅用于执行的会话', json.dumps(result['submission'], ensure_ascii=False))

    def test_missing_origin_is_explicitly_unknown_and_existing_legacy_records_are_not_invented(self):
        item = self.publish()
        self.assertEqual(item['submission']['sources'], [dict(kind='unknown')])
        items = content.read_json(self.directory / '.workbench-content.json')
        del items[0]['submission']
        content.atom(self.directory / '.workbench-content.json', items, 100)
        updated = self.call('bob', op='edit_content', change=dict(id=item['id'], revision=1, action='save', title='旧记录补充', description='只更新正文'))
        self.assertNotIn('submission', updated)

    def test_team_merge_creates_new_identity_and_readable_history(self):
        sources = [self.publish(name=f'source-{index}.zip') for index in range(3)]
        change = dict(requestId=str(uuid.uuid4()), sources=[dict(id=item['id'], revision=item['revision']) for item in sources], replaceIds=[item['id'] for item in sources], title='综合结论', description='保留原始证据后形成的新结论')
        with self.assertRaises(PermissionError):
            self.call('bob', op='merge_content', change=change)
        stale = copy.deepcopy(change)
        stale['sources'][0]['revision'] = 99
        with self.assertRaises(ValueError):
            self.call('alice', op='merge_content', change=stale)
        self.assertEqual(len(content.read_json(self.directory / '.workbench-content.json')), 3)
        result = self.call('alice', op='merge_content', change=change)
        self.assertEqual(self.call('alice', op='merge_content', change=change)['id'], result['id'])
        with self.assertRaises(ValueError):
            self.call('alice', op='merge_content', change=dict(change, replaceIds=[]))
        self.assertNotIn(result['id'], {item['id'] for item in sources})
        self.assertEqual(result['derivedFrom'], result['replaces'])
        self.assertEqual({item['id'] for item in content.read_json(self.directory / '.workbench-content.json')}, {result['id']})
        history = self.call('bob', op='content_history')
        self.assertEqual({item['id'] for item in history}, {item['id'] for item in sources})
        self.assertTrue(all(not item['description'] for item in self.call('bob', op='content_history', summary=True)))
        for source in sources:
            frozen = self.call('bob', op='content_history', id=source['id'], revision=source['revision'])[0]
            self.assertEqual(frozen['description'], source['description'])
            self.assertEqual(frozen['author'], source['author'])
            self.assertEqual(frozen['supersededBy']['id'], result['id'])
        with self.assertRaises(PermissionError):
            self.call('carol', op='content_history')
        with self.assertRaises(PermissionError):
            self.call('carol', op='merge_content', change=change)
        with self.assertRaises(ValueError):
            self.call('alice', op='merge_content', change=dict(change, requestId=str(uuid.uuid4())))

    def test_merge_index_failure_restores_current_and_history(self):
        sources = [self.publish(name=f'rollback-{index}.zip') for index in range(2)]
        change = dict(sources=[dict(id=item['id'], revision=1) for item in sources], replaceIds=[item['id'] for item in sources], title='合并', description='正文')
        original_atom = content.atom
        def fail_index(file, data, gid=None):
            if file == self.directory / '.workbench-content.json' and len(data) == 1:
                raise OSError('disk failure')
            return original_atom(file, data, gid)
        with patch.object(content, 'atom', side_effect=fail_index), self.assertRaises(OSError):
            self.call('alice', op='merge_content', change=change)
        self.assertEqual({item['id'] for item in content.read_json(self.directory / '.workbench-content.json')}, {item['id'] for item in sources})
        self.assertEqual(self.call('alice', op='content_history'), [])

    def test_sources_can_support_different_result_combinations(self):
        a, b, c = [self.publish(name=f'combination-{index}.zip') for index in range(3)]
        def merge(*sources, replace_ids=None):
            return self.call('alice', op='merge_content', change=dict(
                requestId=str(uuid.uuid4()),
                sources=[dict(id=item['id'], revision=item['revision']) for item in sources],
                replaceIds=replace_ids or [], title='不同角度的结论', description='按当前组合得出的判断'))
        first = merge(a, b)
        second = merge(b, c)
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(first['replaces'], [])
        self.assertEqual(second['replaces'], [])
        self.assertEqual({item['id'] for item in content.read_json(self.directory / '.workbench-content.json') if item['kind'] == 'contribution'}, {a['id'], b['id'], c['id'], first['id'], second['id']})
        self.assertIn(b['id'], {ref['id'] for ref in first['derivedFrom']})
        self.assertIn(b['id'], {ref['id'] for ref in second['derivedFrom']})
        third = merge(a, c, replace_ids=[a['id']])
        self.assertEqual([ref['id'] for ref in third['replaces']], [a['id']])
        self.assertEqual(self.call('alice', op='content_history', id=a['id'])[0]['supersededBy']['id'], third['id'])
        self.assertIn(c['id'], {item['id'] for item in content.read_json(self.directory / '.workbench-content.json')})
        with self.assertRaises(ValueError):
            merge(b, c, replace_ids=[a['id']])

    def test_explicit_delete_leaves_only_a_tombstone_not_historical_body(self):
        item = self.publish()
        edited = self.edit('alice', item, title='新版', description='后来需要移除的内容')
        self.assertEqual(edited['id'], item['id'])
        self.assertEqual(edited['revision'], 2)
        self.assertEqual(self.call('alice', op='content_history', id=item['id'], revision=1)[0]['description'], item['description'])
        old_file, new_file = content.safe(self.root, item['path']), content.safe(self.root, edited['path'])
        old_file.write_bytes(b'stale-version')
        self.call('alice', op='edit_content', change=dict(id=item['id'], revision=2, action='delete', curate=False, merge=[]))
        history = self.call('bob', op='content_history', id=item['id'])
        stored = json.dumps(content.read_json(self.directory / '.workbench-content-history.json'), ensure_ascii=False)
        self.assertEqual(len(history), 1)
        self.assertTrue(history[0]['deletedAt'])
        self.assertEqual(history[0]['description'], '')
        self.assertIsNone(history[0]['sourceDetails'])
        self.assertFalse(old_file.exists())
        self.assertFalse(new_file.exists())
        receipts = content.read_json(self.root / '.workbench/admin/uploads.json', {})
        self.assertFalse(any(isinstance(value, dict) and value.get('id') == item['id'] for value in receipts.values()))
        self.assertNotIn('已验证内容', json.dumps(receipts, ensure_ascii=False))
        self.assertNotIn('后来需要移除的内容', stored)
        self.assertNotIn('已验证内容', stored)

    def test_deleted_trajectory_and_history_drop_unreferenced_files(self):
        target = '/projects/relation/实体抽取/trajectories/bob/session.zip'
        item = self.call('bob', op='publish', target=target, sha256=content.digest(self.incoming), metadata={'title': '轨迹', 'description': '快照', 'kind': 'trajectory'})
        orphan = self.directory / 'trajectories' / 'bob' / 'left-behind.txt'
        orphan.write_bytes(b'orphan')
        self.call('bob', op='edit_content', change=dict(id=item['id'], revision=1, action='delete'))
        self.assertFalse(content.safe(self.root, target).exists())
        self.assertFalse(orphan.exists())
        self.assertTrue((self.directory / '项目说明.md').is_file())
        sources = [self.publish(name=f'hist-{index}.md') for index in range(2)]
        result = self.call('alice', op='merge_content', change=dict(sources=[dict(id=item['id'], revision=1) for item in sources], replaceIds=[item['id'] for item in sources], title='合并后', description='新正文'))
        self.call('alice', op='edit_content', change=dict(id=sources[0]['id'], revision=1, action='delete'))
        self.assertFalse(content.safe(self.root, sources[0]['path']).exists())
        self.assertTrue(content.safe(self.root, sources[1]['path']).is_file())
        self.assertTrue(content.safe(self.root, result['path']).is_file())
        self.assertEqual(self.call('alice', op='content_history', id=sources[0]['id']), [])
        with self.assertRaises(PermissionError):
            self.call('bob', op='reap_project_files')
        stray = self.directory / 'trajectories' / 'bob' / 'stray.txt'
        stray.parent.mkdir(parents=True, exist_ok=True)
        stray.write_bytes(b'stray')
        self.assertGreaterEqual(self.call('alice', op='reap_project_files')['removed'], 1)
        self.assertFalse(stray.exists())
        self.assertTrue(content.safe(self.root, result['path']).is_file())

    def test_private_account_data_is_isolated_versioned_and_not_public(self):
        self.assertEqual(self.call('bob', op='account_read')['records'], {})
        data = {'material:one': {'title': 'private'}, 'result-rules:preferences': {'combinations': [], 'projects': {self.project: 'development'}}}
        first = self.call('bob', op='account_write', revision=0, records=data, username='alice')
        self.assertEqual(first['revision'], 1)
        self.assertEqual(self.call('alice', op='account_read')['records'], {})
        self.assertTrue(self.call('bob', op='account_write', revision=0, records={})['conflict'])
        self.assertEqual(self.call('bob', op='account_read')['records'], data)
        with self.assertRaises(ValueError): self.call('bob', op='account_write', revision=1, records={'sessions:x': 'forbidden'})
        self.assertFalse(list(self.directory.glob('*account*')))
        self.state['users']['bob']['enabled'] = False
        with self.assertRaises(PermissionError): self.call('bob', op='account_read')

    def test_attachments_are_deduplicated_authorized_and_required_before_publication(self):
        sha = content.digest(self.incoming)
        blob = self.call('bob', op='publish_attachment', sha256=sha)
        self.assertEqual(blob, self.call('bob', op='publish_attachment', sha256=sha))
        attachment = dict(blob, name='result.csv')
        metadata = dict(kind='contribution', title='with evidence', description='summary', attachments=[attachment])
        target = '/projects/relation/实体抽取/submissions/bob/result.zip'
        item = self.call('bob', op='publish', target=target, sha256=sha, metadata=metadata)
        self.assertEqual(item['attachments'], [attachment])
        with self.assertRaises(PermissionError): self.call('alice', op='publish', target=target + '2', sha256=sha, metadata=metadata)
        with self.assertRaises(ValueError): self.call('bob', op='publish', target=target + '2', sha256=sha, metadata=dict(metadata, attachments=[dict(attachment, size=999)]))
        self.assertEqual(len(content.read_json(self.directory / '.workbench-content.json')), 1)
        edited = self.edit('alice', item)
        self.assertEqual(edited['attachments'], [attachment])
        blob_file = content.safe(self.root, attachment['path'])
        second = self.call('bob', op='publish', target=target + '2', sha256=sha, metadata=dict(metadata, title='second'))
        self.edit('alice', edited, action='delete')
        self.assertTrue(blob_file.is_file())
        self.edit('alice', second, action='delete')
        self.assertFalse(blob_file.exists())

    def test_attachment_cleanup_respects_other_results_historical_references(self):
        sha = content.digest(self.incoming)
        blob = self.call('bob', op='publish_attachment', sha256=sha)
        attachment = dict(blob, name='evidence.csv')
        metadata = dict(kind='contribution', title='evidence', description='text', attachments=[attachment])
        base = '/projects/relation/实体抽取/submissions/bob/'
        owner = self.call('bob', op='publish', target=base + 'owner.md', sha256=sha, metadata=metadata)
        other = self.call('bob', op='publish', target=base + 'other.md', sha256=sha, metadata=metadata)
        edited = self.edit('alice', other)
        index = self.directory / '.workbench-content.json'
        items = content.read_json(index)
        next(item for item in items if item['id'] == other['id'])['attachments'] = []
        index.write_text(json.dumps(items), encoding='utf-8')
        self.edit('alice', owner, action='delete')
        self.assertTrue(content.safe(self.root, blob['path']).is_file())
        self.edit('alice', edited, action='delete')
        self.assertFalse(content.safe(self.root, blob['path']).exists())

    def test_missing_source_file_cannot_be_adopted_into_a_new_task(self):
        item = self.publish()
        content.safe(self.root, item['path']).unlink()
        with self.assertRaisesRegex(ValueError, '关联成果文件'):
            content.assignment_snapshot(self.root, self.directory, self.project, 'bob', str(uuid.uuid4()), 'alice', [dict(id=item['id'], revision=item['revision'])], [], '派发人上传')
        self.assertEqual(len(content.read_json(self.directory / '.workbench-content.json')), 1)

    def test_account_files_are_private_and_downloads_are_independent(self):
        self.state['users']['bob']['uid'] = 1001
        sha = content.digest(self.incoming)
        self.call('bob', op='account_file_upload', sha256=sha)
        with self.assertRaises(ValueError): self.call('alice', op='account_file_download', sha256=sha)
        first = self.call('bob', op='account_file_download', sha256=sha)
        second = self.call('bob', op='account_file_download', sha256=sha)
        self.assertNotEqual(first['downloadId'], second['downloadId'])
        self.assertEqual(first['sha256'], sha)
        with self.assertRaises(ValueError): self.call('bob', op='account_file_upload', sha256='../escape')

    def test_assignment_roles_snapshots_status_and_retries(self):
        source = self.publish()
        task = dict(id=str(uuid.uuid4()), title='排查失败样本', description='分析低清晰度识别失败', acceptance='提供回归报告', assignee='bob', references=[dict(id=source['id'], revision=source['revision'])])
        self.assertEqual({item['username'] for item in self.call('alice', op='assignment_members')}, {'alice', 'bob'})
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_members')
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_create', task=task)
        with self.assertRaises(ValueError): self.call('alice', op='assignment_create', task={**task, 'assignee': 'carol'})
        with self.assertRaises(ValueError): self.call('alice', op='assignment_create', task={**task, 'references': [dict(id=source['id'], revision=99)]})
        saved = self.call('alice', op='assignment_create', task=task)
        self.assertEqual(self.call('alice', op='assignment_create', task=task), saved)
        with self.assertRaises(ValueError): self.call('alice', op='assignment_create', task={**task, 'title': '不同任务'})
        self.assertEqual(len(self.call('bob', op='assignment_list')), 1)
        self.assertFalse((self.directory / '.workbench-assignments.json').exists(), 'task records must not be group-readable')
        self.edit('alice', source, action='delete')
        self.assertEqual(self.call('bob', op='assignment_list')[0]['references'][0]['content'], '已验证内容')
        own = self.call('alice', op='assignment_create', task={**task, 'id': str(uuid.uuid4()), 'assignee': 'alice', 'references': []})
        self.assertEqual(len(self.call('bob', op='assignment_list')), 1)
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_status', change=dict(id=own['id'], revision=1, status='in_progress'))
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_status', change=dict(id=saved['id'], revision=1, status='cancelled'))
        active = self.call('bob', op='assignment_status', change=dict(id=saved['id'], revision=1, status='in_progress'))
        with self.assertRaises(ValueError): self.call('bob', op='assignment_status', change=dict(id=saved['id'], revision=1, status='completed'))
        review = self.call('bob', op='assignment_lifecycle', change=dict(id=saved['id'], revision=active['revision'], status='pending_review', submission=dict(summary='已验证任务结果')))
        done = self.call('alice', op='assignment_lifecycle', change=dict(id=saved['id'], revision=review['revision'], status='completed'))
        self.assertEqual(done['status'], 'completed')
        self.state['users']['alice']['contentAdminGroups'] = []
        with self.assertRaises(PermissionError): self.call('alice', op='assignment_create', task={**task, 'id': str(uuid.uuid4())})
        self.state['users']['bob']['groups'] = []
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_list')

    def test_assignment_review_delete_restore_and_reference_safe_purge(self):
        self.state['users']['bob']['uid'] = 1001
        self.state['users']['alice']['uid'] = 1000
        source = self.publish(kind='file', name='original.txt')
        spec = dict(id=str(uuid.uuid4()), title='评估是否继续', description='比较候选与基线', acceptance='提供依据', assignee='bob', references=[dict(id=source['id'], revision=1)])
        first = self.call('alice', op='assignment_create', task=spec)
        second = self.call('alice', op='assignment_create', task={**spec, 'id': str(uuid.uuid4())})
        blob = content.assignment_blob(self.root, self.project, 'bob', first['files'][0])
        def change(actor, task, status, **extra):
            return self.call(actor, op='assignment_lifecycle', change=dict(id=task['id'], revision=task['revision'], status=status, **extra))
        with self.assertRaises(ValueError): change('alice', first, 'deleted')
        with self.assertRaises(ValueError): change('alice', first, 'cancelled', reason='   ')
        task = change('bob', first, 'in_progress')
        with self.assertRaises(PermissionError): change('bob', task, 'completed')
        with self.assertRaises(ValueError): change('alice', task, 'completed')
        with self.assertRaises(ValueError): change('bob', task, 'pending_review', submission=dict(summary='   '))
        upload = dict(id=str(uuid.uuid4()), name='proof.txt', sha256=content.digest(self.incoming), size=self.incoming.stat().st_size)
        with self.assertRaises(PermissionError): self.call('alice', op='assignment_file_upload', taskId=task['id'], file=upload)
        self.call('bob', op='assignment_file_upload', taskId=task['id'], file=upload)
        submission = dict(summary='候选不优于基线，不建议继续', references=[dict(id=source['id'], revision=1)], uploadIds=[upload['id']])
        with self.assertRaises(ValueError): change('bob', task, 'pending_review', submission={**submission, 'references': [dict(id=source['id'], revision=999)]})
        self.assertEqual(next(item for item in self.call('bob', op='assignment_list') if item['id'] == task['id'])['status'], 'in_progress')
        task = change('bob', task, 'pending_review', submission=submission)
        self.assertEqual(task['submissions'][0]['submittedBy'], 'bob')
        self.assertEqual(len(task['submissions'][0]['files']), 2)
        self.assertFalse(content.assignment_stage(self.root, self.project, 'bob', task['id'], upload['id']).exists())
        with self.assertRaises(PermissionError): change('bob', task, 'completed')
        with self.assertRaises(ValueError): change('alice', task, 'in_progress')
        with self.assertRaises(ValueError): change('alice', task, 'completed', submission=submission)
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_file_upload', taskId=task['id'], file=upload)
        self.state['users']['carol']['groups'].append('relation')
        self.state['users']['carol']['contentAdminGroups'] = ['relation']
        task = change('carol', task, 'in_progress', reason='补充适用范围')
        self.assertEqual(task['history'][-1]['by'], 'carol')
        self.assertEqual(task['history'][-1]['action'], 'rejected')
        task = change('bob', task, 'pending_review', submission=dict(summary='当前样本内不优于基线，依据见上次附件'))
        self.assertEqual(len(task['submissions']), 2)
        with self.assertRaises(ValueError): change('alice', {**task, 'revision': 1}, 'completed')
        task = change('carol', task, 'completed', reason='按探索目标验收通过')
        self.assertEqual(task['history'][-1]['by'], 'carol')
        downloaded = self.call('bob', op='assignment_file_download', taskId=task['id'], fileId=task['submissions'][0]['files'][1]['id'])
        self.assertEqual(downloaded['sha256'], upload['sha256'])
        self.state['users']['carol']['contentAdminGroups'] = []
        with self.assertRaises(PermissionError): change('carol', task, 'deleted')
        with self.assertRaises(PermissionError): change('bob', task, 'deleted')
        task = change('alice', task, 'deleted')
        self.assertFalse(any(item['id'] == task['id'] for item in self.call('bob', op='assignment_list')))
        self.assertTrue(any(item['id'] == task['id'] and item.get('deletedAt') for item in self.call('alice', op='assignment_list')))
        self.assertEqual(blob.read_bytes(), b'original')
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_file_download', taskId=task['id'], fileId=first['files'][0]['id'])
        task = change('alice', task, 'restored')
        self.assertEqual(task['status'], 'completed'); self.assertEqual(len(task['submissions']), 2)
        task = change('alice', task, 'deleted')
        task = change('alice', task, 'purged')
        self.assertEqual(task['title'], ''); self.assertEqual(task['submissions'], [])
        self.assertFalse(any(item['id'] == task['id'] for item in self.call('alice', op='assignment_list')))
        with self.assertRaises(ValueError): self.call('alice', op='assignment_create', task=spec)
        with self.assertRaises(PermissionError): change('alice', task, 'restored')
        with self.assertRaises(PermissionError): self.call('alice', op='assignment_file_download', taskId=task['id'], fileId=first['files'][0]['id'])
        self.assertEqual(content.assignment_resolve(self.root, self.project, 'bob', second['id'], second['files'][0]), blob)
        self.assertEqual(blob.read_bytes(), b'original')
        second = change('alice', second, 'cancelled', reason='重复任务')
        second = change('alice', second, 'deleted')
        self.assertEqual(blob.read_bytes(), b'original', 'recoverable tasks retain their blobs')
        change('alice', second, 'purged')
        self.assertFalse(blob.exists())
        self.assertEqual(content.safe(self.root, source['path']).read_bytes(), b'original', 'shared source is never deleted with a task')
        self.assertEqual(len(content.read_json(self.directory / '.workbench-content.json')), 1)

    def edit(self, actor, item, **change):
        return self.call(actor, op='edit_content', change={'id': item['id'], 'revision': item['revision'], 'action': 'save', 'title': '新标题', 'description': '新证据', **change})

    def test_owner_updates_then_admin_locks(self):
        item = self.edit('bob', self.publish())
        self.assertEqual(item['revision'], 2)
        curated = self.edit('alice', item, curate=True)
        self.assertEqual(curated['author'], 'bob'); self.assertEqual(curated['state'], 'curated')
        for action in ['save', 'delete']:
            with self.assertRaises(PermissionError): self.edit('bob', curated, action=action)

    def test_group_scope_and_distinct_roles(self):
        with self.assertRaises(PermissionError): self.publish('carol')
        with self.assertRaises(PermissionError): self.call('bob', op='save_brief', brief=BRIEF, revision=1)
        project = self.call('bob', op='create_project', name='OCR', groupName='ocr')
        with self.assertRaises(PermissionError): self.call('alice', op='save_brief', projectId=project['projectId'], brief=BRIEF, revision=0)

    def test_other_member_cannot_update_or_claim_curation(self):
        self.state['users']['carol']['groups'].append('relation')
        item = self.publish()
        with self.assertRaises(PermissionError): self.edit('carol', item)
        with self.assertRaises(PermissionError): self.edit('bob', item, curate=True)
        with self.assertRaises(PermissionError): self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/alice/injected', sha256=content.digest(self.incoming))

    def test_retry_does_not_duplicate_or_restore_curated_item(self):
        original = self.publish(); curated = self.edit('alice', original)
        retry = self.publish()
        self.assertEqual(retry['id'], original['id'])
        items = content.read_json(self.directory / '.workbench-content.json')
        self.assertEqual(len(items), 1); self.assertEqual(items[0]['path'], curated['path'])
        self.assertFalse((self.directory / 'submissions/bob/result.zip').exists())

    def test_stale_revision_rejected_and_merge_preserves_source_history(self):
        one = self.publish(); two = self.publish(name='second.zip')
        updated = self.edit('bob', one)
        with self.assertRaises(ValueError): self.edit('alice', one)
        with self.assertRaisesRegex(ValueError, '旧版合并入口'):
            self.edit('alice', updated, merge=[{'id': two['id'], 'revision': two['revision']}])
        result = self.call('alice', op='merge_content', change=dict(requestId=str(uuid.uuid4()), sources=[{'id': updated['id'], 'revision': updated['revision']}, {'id': two['id'], 'revision': two['revision']}], replaceIds=[updated['id'], two['id']], title='合并结论', description='已合并', sourceSessionTitle='统一口径复核'))
        self.assertNotIn(result['id'], {updated['id'], two['id']})
        self.assertEqual(set(result['sources']), {updated['id'], two['id']})
        self.assertEqual({source['id'] for source in result['provenance']}, {updated['id'], two['id']})
        self.assertEqual(result['sourceSessionTitle'], '统一口径复核')
        self.assertTrue((self.directory / 'submissions/bob/second.zip').exists())
        self.assertEqual(self.call('alice', op='content_history', id=two['id'], revision=two['revision'])[0]['description'], two['description'])
        self.assertEqual(len(content.read_json(self.directory / '.workbench-content.json')), 1)

    def test_author_can_delete_only_pending(self):
        item = self.publish()
        self.assertIsNone(self.edit('bob', item, action='delete'))
        self.assertEqual(content.read_json(self.directory / '.workbench-content.json'), [])

    def test_replacement_creates_new_revision_and_locks_for_admin(self):
        item = self.publish(kind='file'); self.incoming.write_bytes(b'replacement')
        request = dict(op='edit_content', change={'id': item['id'], 'revision': 1, 'action': 'save', 'title': '文件', 'description': '已替换'}, replacement={'extension': '.bin', 'sha256': content.digest(self.incoming)})
        result = self.call('alice', **request)
        self.assertEqual(content.safe(self.root, result['path']).read_bytes(), b'replacement')
        self.assertEqual(result['state'], 'curated')
        self.assertFalse(content.safe(self.root, item['path']).exists())
        request['change']['revision'] = 2
        with self.assertRaises(PermissionError): self.call('bob', **request)

    def test_project_lifecycle_uses_marker_not_empty_directory(self):
        (self.root / 'projects/relation/.keep').write_text('keep')
        other = self.call('alice', op='create_project', name='另一个项目', groupName='relation')['projectId']
        self.assertNotEqual(other, self.project)
        self.assertTrue((self.directory / 'trajectories').is_dir())
        with self.assertRaises(FileExistsError): self.call('alice', op='create_project', name='实体抽取', groupName='relation')

    def test_brief_versions_reject_stale_saves(self):
        result = self.call('alice', op='save_brief', brief={**BRIEF, 'objectives': '新目标'}, revision=1)
        self.assertEqual(result['briefRevision'], 2)
        self.assertIn('新目标', (self.directory / '.brief-versions/2.md').read_text(encoding='utf-8'))
        with self.assertRaises(ValueError): self.call('alice', op='save_brief', brief=BRIEF, revision=1)
        with self.assertRaises(ValueError): self.call('alice', op='save_brief', brief={}, revision=2)

    def test_live_revocation_disabled_identity_and_checksum(self):
        item = self.publish()
        self.state['users']['bob']['groups'] = []
        with self.assertRaises(PermissionError): self.edit('bob', item)
        self.state['users']['bob']['groups'] = ['relation']; self.state['users']['bob']['enabled'] = False
        with self.assertRaises(PermissionError): self.edit('bob', item)
        with self.assertRaises(ValueError): self.call('alice', op='publish', target='/projects/relation/实体抽取/submissions/alice/bad', sha256='0' * 64)

    def test_path_escape_and_management_file_writes_rejected(self):
        for target in ['/projects/relation/实体抽取/../outside', '/projects/relation/实体抽取/.workbench-project.json', '/projects/ocr/a']:
            with self.assertRaises((PermissionError, ValueError)): self.call('alice', op='publish', target=target, sha256=content.digest(self.incoming))

    def test_categorized_contribution_is_bound_to_its_server_path(self):
        metadata = {'title': '覆盖率结论', 'description': '有证据的结论', 'kind': 'contribution', 'category': 'finding', 'fields': {'statement': '覆盖不足'}, 'sourceSessionTitle': '覆盖率验证'}
        with self.assertRaises(PermissionError):
            self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/issues/wrong.zip', sha256=content.digest(self.incoming), metadata=metadata)
        item = self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/findings/right.zip', sha256=content.digest(self.incoming), metadata=metadata)
        self.assertEqual(item['category'], 'finding'); self.assertEqual(item['fields']['statement'], '覆盖不足'); self.assertEqual(item['sourceSessionTitle'], '覆盖率验证')
        with self.assertRaises(ValueError):
            self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/findings/bad.zip', sha256=content.digest(self.incoming), metadata={**metadata, 'fields': ['wrong']})
        with self.assertRaises(ValueError):
            self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/findings/extra.zip', sha256=content.digest(self.incoming), metadata={**metadata, 'fields': {'problem': '属于 issue 的字段'}})

    def test_legacy_files_can_be_adopted_and_maintained_only_by_subadmin(self):
        file = self.directory / 'legacy.txt'; file.write_text('历史内容', encoding='utf-8')
        target = '/projects/relation/实体抽取/legacy.txt'
        with self.assertRaises(PermissionError): self.call('bob', op='adopt_content', target=target)
        item = self.call('alice', op='adopt_content', target=target)
        self.assertEqual(item['state'], 'curated'); self.assertEqual(item['description'], '历史内容')
        self.assertEqual(self.call('alice', op='adopt_content', target=target)['id'], item['id'])
        with self.assertRaises(ValueError): self.call('alice', op='adopt_content', target='/projects/relation/实体抽取/.workbench-project.json')
        with self.assertRaises(ValueError): self.call('alice', op='adopt_content', target='/projects/ocr')

    def test_new_categories_publish_with_matching_paths_and_keep_category_in_assignment_snapshots(self):
        for category in ['requirement', 'design', 'verification', 'troubleshooting', 'guide', 'research', 'comparison']:
            folder = content.CONTRIBUTION_FOLDERS[category]
            field = next(iter(content.CONTRIBUTION_FIELDS[category]))
            metadata = dict(kind='contribution', category=category, title='简短成果', description='有依据的内容。', fields={field: '有依据的内容。'})
            item = self.call('bob', op='publish', target=f'/projects/relation/实体抽取/submissions/bob/{folder}/{category}.md', sha256=content.digest(self.incoming), metadata=metadata)
            self.assertEqual(item['category'], category)
            task = self.call('alice', op='assignment_create', task=dict(id=str(uuid.uuid4()), title='自派任务', description='验证该成果', assignee='alice', references=[dict(id=item['id'], revision=1)]))
            self.assertEqual(task['references'][0]['category'], category)
            started = self.call('alice', op='assignment_status', change=dict(id=task['id'], revision=1, status='in_progress'))
            self.assertEqual(started['status'], 'in_progress')
            self.assertEqual(self.call('alice', op='assignment_status', change=dict(id=task['id'], revision=2, status='completed', submission=dict(summary='自派任务已验证')))['status'], 'completed')
            with self.assertRaises(ValueError): self.edit('alice', item, category='invented')
            self.assertEqual(next(row for row in content.read_json(self.directory / '.workbench-content.json') if row['id'] == item['id'])['revision'], 1)
            edited = self.edit('alice', item, category='verification', sourceDetails='验证来源。')
            self.assertEqual(edited['category'], 'verification'); self.assertEqual(edited['fields'], metadata['fields'] if category == 'verification' else {}); self.assertEqual(edited['sourceDetails'], '验证来源。')

    def test_task_files_snapshot_shared_attachments_and_deduplicate_only_equal_permissions(self):
        self.state['users']['bob']['uid'] = 1001
        self.state['users']['carol']['groups'].append('relation'); self.state['users']['carol']['uid'] = 1002
        sha = content.digest(self.incoming)
        shared = self.call('bob', op='publish_attachment', sha256=sha)
        linked = self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/result.md', sha256=sha, metadata=dict(kind='contribution', title='关联成果', description='验证内容', attachments=[dict(shared, name='data.csv')]))
        request_id, upload_id = str(uuid.uuid4()), str(uuid.uuid4())
        upload = dict(id=upload_id, name='data.csv', sha256=sha, size=self.incoming.stat().st_size)
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_file_upload', taskId=request_id, file=upload)
        staged = self.call('alice', op='assignment_file_upload', taskId=request_id, file=upload)
        self.assertEqual(staged['md5'], content.hashlib.md5(b'original', usedforsecurity=False).hexdigest())
        task = dict(id=request_id, title='附件任务', description='审阅文件', assignee='bob', references=[dict(id=linked['id'], revision=1)], uploadIds=[upload_id])
        first = self.call('alice', op='assignment_create', task=task)
        self.assertEqual(len(first['files']), 1)
        self.assertFalse(content.assignment_stage(self.root, self.project, 'alice', request_id, upload_id).exists())
        self.assertEqual(self.call('alice', op='assignment_create', task=task)['id'], request_id)
        same = self.call('alice', op='assignment_create', task={**task, 'id': str(uuid.uuid4()), 'uploadIds': []})
        other = self.call('alice', op='assignment_create', task={**task, 'id': str(uuid.uuid4()), 'assignee': 'carol', 'uploadIds': []})
        get_blob = lambda item: content.assignment_resolve(self.root, self.project, item['assignee'], item['id'], item['files'][0])
        self.assertEqual(get_blob(first), get_blob(same)); self.assertNotEqual(get_blob(first), get_blob(other))
        self.assertNotEqual(first['files'][0]['path'], same['files'][0]['path'])
        if os.name != 'nt': self.assertTrue((self.root / first['files'][0]['path'].lstrip('/')).is_symlink())
        with self.assertRaises(PermissionError): self.call('carol', op='assignment_file_download', taskId=request_id, fileId=first['files'][0]['id'])
        self.edit('alice', linked, action='delete')
        self.incoming.write_bytes(b'new local version')
        downloaded = self.call('bob', op='assignment_file_download', taskId=request_id, fileId=first['files'][0]['id'])
        self.assertEqual(downloaded['sha256'], sha)
        outgoing = self.root / '.workbench/outbox/bob' / (sha + '-' + downloaded['downloadId'] + '.file')
        self.assertEqual(outgoing.read_bytes(), b'original')
        tampered = dict(first['files'][0], path=other['files'][0]['path'])
        with self.assertRaises(ValueError): content.assignment_resolve(self.root, self.project, 'bob', request_id, tampered)
        get_blob(first).write_bytes(b'corrupt')
        with self.assertRaises(ValueError): self.call('bob', op='assignment_file_download', taskId=request_id, fileId=first['files'][0]['id'])
        self.state['users']['bob']['enabled'] = False
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_file_download', taskId=same['id'], fileId=same['files'][0]['id'])

    def test_task_dedup_does_not_use_md5_alone_and_rejects_forged_file_selection(self):
        sha = content.digest(self.incoming)
        original_hashes = content.assignment_hashes
        # Simulate an MD5 collision: different SHA-256 values must produce distinct blobs.
        with patch.object(content, 'assignment_hashes', side_effect=lambda file: dict(original_hashes(file), md5='a' * 32)):
            first = content.assignment_store(self.root, self.project, 'bob', str(uuid.uuid4()), self.incoming, 'file.txt', sha, self.incoming.stat().st_size, 'test')
            self.incoming.write_bytes(b'different content')
            second = content.assignment_store(self.root, self.project, 'bob', str(uuid.uuid4()), self.incoming, 'file.txt', content.digest(self.incoming), self.incoming.stat().st_size, 'test')
            self.assertNotEqual(content.assignment_blob(self.root, self.project, 'bob', first), content.assignment_blob(self.root, self.project, 'bob', second))
        task = dict(id=str(uuid.uuid4()), title='非法附件', description='测试', assignee='bob', references=[], uploadIds=[str(uuid.uuid4())])
        with self.assertRaises(FileNotFoundError): self.call('alice', op='assignment_create', task=task)
        self.assertEqual(self.call('alice', op='assignment_list'), [])
        with self.assertRaises(ValueError): self.call('alice', op='assignment_file_upload', taskId=task['id'], file=dict(id=str(uuid.uuid4()), name='../file', sha256=sha, size=8))
        source = self.publish(name='shared-file.csv', kind='file')
        linked = self.call('alice', op='assignment_create', task=dict(id=str(uuid.uuid4()), title='关联独立文件', description='读取共享文件', assignee='bob', references=[dict(id=source['id'], revision=1)]))
        self.assertEqual(linked['references'][0]['kind'], 'file'); self.assertEqual(len(linked['files']), 1)
        self.assertEqual(linked['files'][0]['name'], 'shared-file.csv')

class DirectionRules(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        (self.root / '.workbench').mkdir(parents=True)
        self.state = {'users': {
            'alice': {'enabled': True, 'groups': ['relation']},
            'bob': {'enabled': True, 'groups': ['relation']},
            'carol': {'enabled': True, 'groups': ['ocr']}},
            'groups': {'relation': {'workspace': 'projects/relation', 'gid': 100}, 'ocr': {'workspace': 'projects/ocr', 'gid': 100}}}
        for mock in [patch.object(content.os, 'chown', create=True), patch.object(content.os, 'chmod'), patch.object(content.shutil, 'which', return_value='setfacl'), patch.object(content.subprocess, 'run')]:
            mock.start(); self.addCleanup(mock.stop)

    def call(self, actor, **request):
        return content.handle(self.root, self.state, actor, request)

    def test_directions_are_visible_to_every_member_and_only_the_owner_can_change_them(self):
        first, second = str(uuid.uuid4()), str(uuid.uuid4())
        saved = self.call('alice', op='directions_save', directions=[
            dict(id=first, title='检索召回', summary='在做召回实验，可以一起对评测集'),
            dict(id=second, title='接入码', summary='管理端出口接入，可以请教配置'),
        ])
        self.assertEqual(saved['username'], 'alice')
        self.assertEqual([item['title'] for item in saved['directions']], ['检索召回', '接入码'])
        listed = self.call('carol', op='directions_list')['members']
        alice = next(item for item in listed if item['username'] == 'alice')
        self.assertEqual([item['title'] for item in alice['directions']], ['检索召回', '接入码'])
        self.assertTrue(any(item['username'] == 'bob' and item['directions'] == [] for item in listed))
        again = self.call('alice', op='directions_save', directions=saved['directions'])
        self.assertEqual(again['directions'][0]['updatedAt'], saved['directions'][0]['updatedAt'])
        with self.assertRaises(ValueError):
            self.call('alice', op='directions_save', directions=[
                dict(id=str(uuid.uuid4()), title='检索召回', summary='甲'),
                dict(id=str(uuid.uuid4()), title='检索召回', summary='乙'),
            ])
        alice_after = next(item for item in self.call('carol', op='directions_list')['members'] if item['username'] == 'alice')
        self.assertEqual([item['title'] for item in alice_after['directions']], ['检索召回', '接入码'])
        with self.assertRaises(ValueError):
            self.call('bob', op='directions_save', directions=[dict(id=str(uuid.uuid4()), title='方向' + str(n), summary='') for n in range(13)])
        self.call('bob', op='directions_save', directions=[dict(id=str(uuid.uuid4()), title='评测集', summary='可以问失败样本')])
        names = {item['username']: [direction['title'] for direction in item['directions']] for item in self.call('alice', op='directions_list')['members']}
        self.assertEqual(names['alice'], ['检索召回', '接入码'])
        self.assertEqual(names['bob'], ['评测集'])
        self.state['users']['alice']['enabled'] = False
        self.assertFalse(any(item['username'] == 'alice' for item in self.call('bob', op='directions_list')['members']))

@unittest.skipUnless(sys.platform == 'linux' and getattr(os, 'geteuid', lambda: 1)() == 0 and content.acl_backend(), 'requires Linux root and ACL support; Windows does not verify kernel permissions')
class LinuxKernelPermissions(unittest.TestCase):
    def test_libacl_keeps_public_files_read_only_and_groups_isolated(self):
        with patch.object(content.shutil, 'which', return_value=None):
            self.test_members_read_but_cannot_chmod_write_unlink_or_cross_groups()

    def test_libacl_private_inbox_and_read_only_receipt(self):
        with tempfile.TemporaryDirectory(prefix='team-agent-libacl-') as temp, patch.object(content.shutil, 'which', return_value=None):
            root = pathlib.Path(temp); os.chmod(root, 0o755)
            uid = 400000 + os.getpid(); other = uid + 1
            inbox = root / 'inbox'; outbox = root / 'outbox'
            inbox.mkdir(mode=0o700); outbox.mkdir(mode=0o700)
            content.acl_apply(['-m', 'u:' + str(uid) + ':rwx', str(inbox)])
            content.acl_apply(['-m', 'u:' + str(uid) + ':r-x', str(outbox)])
            receipt = outbox / 'receipt'; receipt.write_text('ok'); os.chmod(receipt, 0o600)
            content.acl_apply(['-m', 'u:' + str(uid) + ':r--', str(receipt)])
            for actor in (uid, other):
                pid = os.fork()
                if pid == 0:
                    try:
                        os.setgroups([]); os.setgid(actor); os.setuid(actor)
                        if actor == uid:
                            (inbox / 'request').write_text('request')
                            assert receipt.read_text() == 'ok'
                            denied = [lambda: receipt.write_text('fake'), lambda: receipt.unlink(), lambda: os.chmod(inbox, 0o777)]
                        else:
                            denied = [lambda: (inbox / 'request').read_text(), lambda: receipt.read_text()]
                        for action in denied:
                            try: action(); os._exit(2)
                            except PermissionError: pass
                        os._exit(0)
                    except BaseException: os._exit(3)
                _, status = os.waitpid(pid, 0); self.assertEqual(os.waitstatus_to_exitcode(status), 0)

    def test_members_read_but_cannot_chmod_write_unlink_or_cross_groups(self):
        # No host accounts are created. Fork drops to unused numerical UID/GIDs.
        with tempfile.TemporaryDirectory(prefix='team-agent-acl-') as temp:
            root = pathlib.Path(temp); os.chmod(root, 0o755)
            one, two = root / 'one', root / 'two'
            gid, uid = 300000 + os.getpid(), 400000 + os.getpid()
            content.public_dir(one, gid); content.public_dir(two, gid + 1)
            content.publish_bytes(one / 'result', b'team result', gid)
            content.publish_bytes(two / 'result', b'other team', gid + 1)
            for both in [False, True]:
                pid = os.fork()
                if pid == 0:
                    try:
                        os.setgroups([gid, gid + 1] if both else [gid]); os.setgid(gid); os.setuid(uid)
                        assert (one / 'result').read_bytes() == b'team result'
                        for action in [lambda: (one / 'result').write_bytes(b'hack'), lambda: os.chmod(one / 'result', 0o666), lambda: (one / 'result').unlink()]:
                            try: action(); os._exit(2)
                            except PermissionError: pass
                        if both: assert (two / 'result').read_bytes() == b'other team'
                        else:
                            try: (two / 'result').read_bytes(); os._exit(3)
                            except PermissionError: pass
                        os._exit(0)
                    except BaseException: os._exit(4)
                _, status = os.waitpid(pid, 0); self.assertEqual(os.waitstatus_to_exitcode(status), 0)

if __name__ == '__main__': unittest.main()
