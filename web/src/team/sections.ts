// Sections of the paper for team features: the main file and each file it
// includes. Owners come from CODEOWNERS; status from `.galley.yml`.

import type { OutlineItem } from '../shell/outline';
import { isUserOwner, ownersOf, type OwnerRule } from './codeowners';

export type SectionStatus = 'draft' | 'in_review' | 'approved';
export const SECTION_STATUSES: readonly SectionStatus[] = ['draft', 'in_review', 'approved'];

export function sectionPaths(main: string | undefined, items: readonly OutlineItem[]): string[] {
  const paths = main ? [main] : [];
  for (const item of items) if (item.kind === 'include' && !paths.includes(item.path)) paths.push(item.path);
  return paths;
}

export function sectionOwners(rules: readonly OwnerRule[], paths: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(paths.map((p) => [p, ownersOf(rules, p)]));
}

/** User logins among owners (no teams or emails), without `exclude` (the proposal author). */
export function ownerLogins(owners: readonly string[], exclude?: string): string[] {
  const out: string[] = [];
  for (const o of owners) {
    if (!isUserOwner(o)) continue;
    const login = o.slice(1);
    if (exclude && login.toLowerCase() === exclude.toLowerCase()) continue;
    if (!out.some((x) => x.toLowerCase() === login.toLowerCase())) out.push(login);
  }
  return out;
}

/** Up to two letters for an owner chip: words of the login, or of the team name. */
export function initials(owner: string): string {
  const name = owner.startsWith('@') ? (owner.slice(1).split('/').pop() ?? '') : (owner.split('@')[0] ?? '');
  const words = name.split(/[-_.]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase();
}

/** Admins, and the owners (by login) of a section, change its status. */
export function canChangeStatus({ admin, me, owners }: { admin: boolean; me?: string; owners: readonly string[] }): boolean {
  if (admin) return true;
  if (!me) return false;
  return ownerLogins(owners).some((l) => l.toLowerCase() === me.toLowerCase());
}
