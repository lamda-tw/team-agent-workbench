import test from 'node:test';
import assert from 'node:assert/strict';
import { inProjectWorkgroup } from '../src/shared/project-session-scope';
import type { Project } from '../src/shared/types';
const project = (id: string, groupName?: string): Project => ({ id, groupName, name: id, remoteRoot: '/' + id, uploadPath: '/' + id, historyPath: '/' + id });
test('imported sessions remain in their project when old bindings omit or retain an outdated group', () => {
  const selected = project('research', 'current-group');
  for (const group of [undefined, 'old-group']) assert(inProjectWorkgroup(project('research', group), selected, [selected]));
});
test('group lists use current membership and never a matching display name or stale saved group', () => {
  const selected = project('research', 'current-group'), peer = project('delivery', 'current-group'), other = project('other', 'other-group');
  const projects = [selected, peer, other];
  assert(inProjectWorkgroup(project(peer.id, 'old-group'), selected, projects));
  assert(!inProjectWorkgroup(project(other.id, 'current-group'), selected, projects));
  assert(!inProjectWorkgroup(project('deleted', 'current-group'), selected, projects));
  assert(!inProjectWorkgroup({ ...project('another'), name: selected.name }, selected, projects));
  assert(!inProjectWorkgroup(project('other'), project('research'), projects));
  assert(!inProjectWorkgroup(undefined, selected, projects));
  assert(!inProjectWorkgroup(peer, undefined, projects));
});
