import type { ProjectConfig } from '../config/project';

/**
 * Whether galley offers New section / New subsection. Anyone with write
 * access by default; `structure: admin` keeps it to repository admins. An
 * invalid `.galley.yml` fails closed for co-authors. This is a galley view,
 * not a permission: GitHub still decides who can push.
 */
export function canChangeStructure(project: ProjectConfig, admin: boolean): boolean {
  if (admin) return true;
  if (project.kind === 'missing') return true;
  return project.kind === 'valid' && project.config.structure !== 'admin';
}
