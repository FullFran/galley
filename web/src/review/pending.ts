/**
 * Line numbers in a draft comment refer to the head it was written against.
 * Once the proposal head moves (a suggestion was applied, someone pushed),
 * those numbers may point at other lines, so such drafts must not be sent.
 */
export function splitByHead<T extends { headSha: string }>(items: readonly T[], headSha: string) {
  return {
    current: items.filter((c) => c.headSha === headSha),
    stale: items.filter((c) => c.headSha !== headSha),
  };
}
