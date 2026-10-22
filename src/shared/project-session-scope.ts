import type { Project } from './types';

// Session bindings are historical snapshots. Resolve membership against the
// current project's stable ID rather than the group name saved at import time.
export function inProjectWorkgroup(saved: Project | undefined, selected: Project | undefined, projects: Project[]) {
  if (!saved || !selected) return false;
  if (saved.id === selected.id) return true;
  const current = projects.find(project => project.id === saved.id);
  return !!selected.groupName && !!current && current.groupName === selected.groupName;
}
