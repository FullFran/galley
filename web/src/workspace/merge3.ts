import { diff3Merge } from 'node-diff3';

// Line-level three-way merge of a file the user edited while the default
// branch changed it too: base (what the user started from), yours (the
// buffer) and theirs (the default branch's new text). node-diff3 (MIT,
// about 12 kB of ESM, no dependencies) finds the regions; lines keep their
// own line breaks, so a clean merge reproduces the text exactly.

export type Choice = 'theirs' | 'yours' | 'both';

export type MergeRegion =
  | { kind: 'ok'; text: string }
  | { kind: 'conflict'; yours: string; theirs: string; choice?: Choice };

export type Merge3 = { kind: 'clean'; text: string } | { kind: 'conflict'; regions: MergeRegion[] };

const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

export function merge3(base: string, yours: string, theirs: string): Merge3 {
  const regions: MergeRegion[] = [];
  for (const region of diff3Merge(lines(yours), lines(base), lines(theirs))) {
    if (region.ok) {
      const text = region.ok.join('');
      const last = regions.at(-1);
      if (last?.kind === 'ok') last.text += text;
      else if (text) regions.push({ kind: 'ok', text });
    } else if (region.conflict) {
      regions.push({ kind: 'conflict', yours: region.conflict.a.join(''), theirs: region.conflict.b.join('') });
    }
  }
  if (regions.every((r) => r.kind === 'ok')) return { kind: 'clean', text: regions.map((r) => (r.kind === 'ok' ? r.text : '')).join('') };
  return { kind: 'conflict', regions };
}

/** Records the choice for the conflict at `index`; any other index leaves the regions as they are. */
export function choose(regions: MergeRegion[], index: number, choice: Choice): MergeRegion[] {
  const region = regions[index];
  if (region?.kind !== 'conflict') return regions;
  return regions.map((r, i) => (i === index ? { ...region, choice } : r));
}

const joinBoth = (first: string, second: string) => (first && !first.endsWith('\n') && second ? `${first}\n${second}` : first + second);

/** The merged text once every conflict has a choice; undefined while some are open. */
export function resolvedText(regions: MergeRegion[]): string | undefined {
  let out = '';
  for (const r of regions) {
    if (r.kind === 'ok') out += r.text;
    else if (!r.choice) return undefined;
    else out += r.choice === 'theirs' ? r.theirs : r.choice === 'yours' ? r.yours : joinBoth(r.theirs, r.yours);
  }
  return out;
}

export const openConflicts = (regions: MergeRegion[]) => regions.filter((r) => r.kind === 'conflict' && !r.choice).length;
