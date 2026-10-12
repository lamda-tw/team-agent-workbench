import importlib.util
import copy
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('group_ops',pathlib.Path(__file__).parents[1]/'server/group_ops.py')
groups=importlib.util.module_from_spec(spec);spec.loader.exec_module(groups)

class TeamGroupRules(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name)
        (self.root/'projects').mkdir();(self.root/'.workbench/admin').mkdir(parents=True)
        self.state=dict(root=str(self.root),teamId='teamtest',storageVersion=1,groups={},users={name:dict(username=name,name=name,enabled=True,uid=i+1001,marker='identity-'+name,groups=[],contentAdminGroups=[]) for i,name in enumerate(['alice','bob','carol'])})
        self.native={};self.gids={name:{500} for name in self.state['users']};self.commands=[];self.acls=[]
        def native(name):
            if name not in self.native:raise KeyError(name)
            return types.SimpleNamespace(gr_gid=self.native[name],gr_mem=[name for name,value in self.gids.items() if self.native.get(name) in value])
        def account(name):
            value=self.state['users'].get(name)
            if not value:raise KeyError(name)
            return types.SimpleNamespace(pw_name=name,pw_uid=value['uid'],pw_gid=500,pw_gecos=value['marker'])
        def run(arguments,allowed=(0,)):
            self.commands.append(arguments)
            if arguments[0]=='groupadd':self.native[arguments[-1]]=int(arguments[2])
            elif arguments[0]=='usermod':self.gids[arguments[-1]].add(self.native[arguments[-2]])
            elif arguments[0]=='gpasswd':self.gids[arguments[2]].discard(self.native[arguments[3]])
            elif arguments[0]=='groupdel':self.native.pop(arguments[-1],None)
            elif arguments[0]!='pkill':raise AssertionError(arguments)
        for mock in [patch.dict(sys.modules,{'grp':types.SimpleNamespace(getgrnam=native,getgrall=lambda:[types.SimpleNamespace(gr_gid=gid) for gid in self.native.values()]),'pwd':types.SimpleNamespace(getpwnam=account)}),patch.object(groups,'tg_run',run),patch.object(groups,'tg_acl',lambda value:self.acls.append(value)),patch.object(groups._tg_os,'getgrouplist',lambda name,gid:list(self.gids[name]),create=True),patch.object(groups._tg_os,'chown',create=True),patch.object(groups._tg_os,'chmod')]:mock.start();self.addCleanup(mock.stop)
    def call(self,actor,**command):return groups.tg_handle(self.root,self.state,actor,command)
    def system(self,**command):return groups.tg_handle(self.root,self.state,None,command,system=True)
    def details(self,actor,group):return self.call(actor,action='details',group=group['id'])

    def test_scope_roles_and_account_creation_boundary(self):
        a=self.call('alice',action='create',label='算法组');b=self.call('carol',action='create',label='软件组')
        self.assertEqual(a['role'],'creator');self.assertEqual(a['creator'],'alice')
        with self.assertRaises(PermissionError):self.call('alice',action='create',label='冒用',creator='bob')
        with self.assertRaises(PermissionError):self.call('bob',action='details',group=a['id'])
        with self.assertRaises(ValueError):self.call('alice',action='user_create',username='evil')
        self.call('alice',action='member',group=a['id'],revision=a['revision'],username='bob',role='manager')
        view=self.details('bob',a);self.assertEqual(view['role'],'manager')
        with self.assertRaises(PermissionError):self.call('bob',action='delete',group=a['id'],revision=view['revision'],system=True)
        with self.assertRaises(PermissionError):self.call('bob',action='member',group=b['id'],revision=b['revision'],username='bob',role='manager')
        roles=json.loads((self.root/'.workbench/roles.json').read_text(encoding='utf-8'))
        self.assertEqual(roles['users']['alice']['groups'][0]['role'],'creator')
        self.assertEqual(roles['users']['bob']['groups'][0]['role'],'manager')

    def test_transfer_stale_revision_and_revocation(self):
        group=self.call('alice',action='create',label='合作组')
        self.call('alice',action='member',group=group['id'],revision=group['revision'],username='bob',role='member')
        with self.assertRaises(ValueError):self.call('alice',action='delete',group=group['id'],revision=group['revision'])
        view=self.details('alice',group)
        with self.assertRaises(PermissionError):self.call('alice',action='member',group=group['id'],revision=view['revision'],username='alice',role='remove')
        moved=self.call('alice',action='transfer',group=group['id'],revision=view['revision'],username='bob')
        self.assertEqual(moved['creator'],'bob');self.assertEqual(moved['createdBy'],'alice');self.assertEqual(moved['role'],'manager')
        with self.assertRaises(PermissionError):self.call('alice',action='delete',group=group['id'],revision=moved['revision'])
        view=self.details('bob',group)
        self.call('bob',action='member',group=group['id'],revision=view['revision'],username='alice',role='remove')
        with self.assertRaises(PermissionError):self.details('alice',group)
        self.assertTrue(any('u:1001:---' in value for value in self.acls),'UID ACL denies stale SSH group membership after removal')
        self.assertTrue(any(value==['pkill','-KILL','-u','alice'] for value in self.commands))

    def test_delete_restore_and_purge_are_group_scoped(self):
        group=self.call('alice',action='create',label='回收组');record=self.state['groups'][group['id']]
        project=self.root/record['workspace'].lstrip('/')/'P';project.mkdir();(project/'.workbench-project.json').write_text(json.dumps(dict(id='project-a',name='项目A')));(project/'result.txt').write_text('result')
        view=self.details('alice',group);self.assertEqual(len(view['projects']),1)
        deleted=self.call('alice',action='delete',group=group['id'],revision=view['revision']);self.assertTrue(deleted['deletedAt']);self.assertFalse(project.exists())
        with self.assertRaises(PermissionError):self.call('alice',action='restore',group=group['id'],revision=deleted['revision'])
        restored=self.system(action='restore',group=group['id'],revision=deleted['revision']);self.assertFalse(restored['deletedAt']);self.assertEqual((project/'result.txt').read_text(),'result')
        deleted=self.call('alice',action='delete',group=group['id'],revision=restored['revision']);self.system(action='purge',group=group['id'],revision=deleted['revision'])
        self.assertEqual(self.system(action='list'),[]);self.assertEqual(self.state['users']['alice']['groups'],[])

    def test_reused_account_identity_and_deleted_group_paths(self):
        group=self.call('alice',action='create',label='身份组');self.state['users']['alice']['marker']='new-identity'
        self.assertEqual(self.details('alice',group)['role'],'manager')
        with self.assertRaises(PermissionError):self.call('alice',action='delete',group=group['id'],revision=self.details('alice',group)['revision'])
        self.system(action='transfer',group=group['id'],revision=self.details('alice',group)['revision'],username='bob')
        view=self.details('bob',group);self.call('bob',action='delete',group=group['id'],revision=view['revision'])
        self.assertEqual(groups.tg_role(self.state,self.state['groups'][group['id']],'alice'),None)

    def test_paths_labels_and_global_owner_change_are_checked(self):
        for label in ['../evil','a/b','a\\b','.hidden','name;id','x'*25]:
            with self.assertRaises(ValueError):self.call('alice',action='create',label=label)
        group=self.call('alice',action='create',label='保护组')
        with self.assertRaises(ValueError):groups.tg_creator_change(self.state,'alice',[],[])
        target=self.root/'projects'/'保护组'/'link'
        try:target.symlink_to(self.root,target_is_directory=True)
        except OSError:return
        with self.assertRaises(PermissionError):self.details('alice',group)

    def test_partial_native_creation_can_resume_only_after_identity_checks(self):
        original=groups.tg_run
        def fail(arguments,allowed=(0,)):
            if arguments[0]=='groupadd' and arguments[-1].endswith('_admin'):raise RuntimeError('connection interrupted')
            original(arguments,allowed)
        with patch.object(groups,'tg_run',fail):
            with self.assertRaises(RuntimeError):self.call('alice',action='create',label='中断组')
        pending=self.system(action='list')[0];record=self.state['groups'][pending['id']]
        self.assertTrue(pending['provisioning']);self.assertEqual(self.call('alice',action='list'),[])
        with self.assertRaises(ValueError):self.call('alice',action='resume',group=pending['id'],revision=pending['revision'])
        self.native[record['name']]+=1
        with self.assertRaises(PermissionError):self.system(action='resume',group=pending['id'],revision=pending['revision'])
        self.native[record['name']]=record['gid']
        ready=self.system(action='resume',group=pending['id'],revision=pending['revision'])
        self.assertFalse(ready['provisioning']);self.assertEqual(self.details('alice',ready)['role'],'creator')

    def test_failed_role_publication_keeps_committed_deletion_private_and_recoverable(self):
        group=self.call('alice',action='create',label='发布失败组');record=self.state['groups'][group['id']]
        directory=self.root/record['workspace'].lstrip('/');(directory/'result.txt').write_text('kept')
        view=self.details('alice',group)
        with patch.object(groups,'tg_publish_roles',side_effect=OSError('publish interrupted')):
            with self.assertRaises(OSError):self.call('alice',action='delete',group=group['id'],revision=view['revision'])
        saved=json.loads((self.root/'.workbench/admin/state.json').read_text(encoding='utf-8'))
        self.assertTrue(saved['groups'][group['id']]['deletedAt']);self.assertFalse(directory.exists())
        trash=self.system(action='details',group=group['id']);self.system(action='restore',group=group['id'],revision=trash['revision'])
        self.assertEqual((directory/'result.txt').read_text(),'kept')

    def test_native_membership_changes_preserve_other_groups_and_enable_rejoining(self):
        a=self.call('alice',action='create',label='A组');b=self.call('carol',action='create',label='B组')
        self.call('alice',action='member',group=a['id'],revision=a['revision'],username='bob',role='member')
        self.call('carol',action='member',group=b['id'],revision=b['revision'],username='bob',role='manager')
        self.gids['bob'].add(9999)
        view=self.details('alice',a);self.call('alice',action='member',group=a['id'],revision=view['revision'],username='bob',role='remove')
        self.assertEqual(self.details('bob',b)['role'],'manager');self.assertIn(9999,self.gids['bob'])
        view=self.details('alice',a);self.call('alice',action='member',group=a['id'],revision=view['revision'],username='bob',role='member')
        self.assertEqual(self.details('bob',a)['role'],'member');self.assertTrue(any('u:1002:r-x' in value for value in self.acls))

    def test_same_size_content_change_invalidates_delete_confirmation(self):
        group=self.call('alice',action='create',label='核对组');record=self.state['groups'][group['id']]
        file=self.root/record['workspace'].lstrip('/')/'result.txt';file.write_text('old')
        view=self.details('alice',group);file.write_text('new')
        groups._tg_os.utime(file,ns=(file.stat().st_atime_ns,file.stat().st_mtime_ns+10000000))
        with self.assertRaisesRegex(ValueError,'已变化'):self.call('alice',action='delete',group=group['id'],revision=view['revision'])
        self.assertEqual(file.read_text(),'new')

if __name__=='__main__':unittest.main()
