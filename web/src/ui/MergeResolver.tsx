import { useT } from '../i18n';
import { choose, openConflicts, type Choice, type MergeRegion } from '../workspace/merge3';

export interface MergeResolverProps {
  path: string;
  /** The default branch's name, for "Their version (main)". */
  branch: string;
  regions: MergeRegion[];
  onChange: (regions: MergeRegion[]) => void;
  /** Every place has a choice: make the result the file's text. */
  onApply: () => void;
}

/**
 * Shown instead of the editor while the default branch and the user changed
 * the same lines of a file. Each place shows both texts side by side with
 * three plain choices; no conflict markers ever reach the text.
 */
export function MergeResolver({ path, branch, regions, onChange, onApply }: MergeResolverProps) {
  const m = useT().resolve;
  const places = regions.flatMap((r, index) => (r.kind === 'conflict' ? [{ region: r, index }] : []));
  const left = openConflicts(regions);
  const option = (index: number, current: Choice | undefined, choice: Choice, label: string) => (
    <button type="button" aria-pressed={current === choice} onClick={() => onChange(choose(regions, index, choice))}>
      {label}
    </button>
  );
  const text = (value: string) => (value ? <pre class="merge-text">{value}</pre> : <p class="muted merge-text">{m.empty}</p>);
  return (
    <section class="merge-resolver" aria-labelledby="merge-title">
      <h2 id="merge-title">{m.title(path)}</h2>
      <p class="muted">{m.intro}</p>
      <ol class="merge-places">
        {places.map(({ region, index }, i) => (
          <li key={index} class="merge-place">
            <h3>{m.place(i + 1, places.length)}</h3>
            <div class="merge-sides">
              <div class="merge-side">
                <h4>{m.theirs(branch)}</h4>
                {text(region.theirs)}
              </div>
              <div class="merge-side">
                <h4>{m.yours}</h4>
                {text(region.yours)}
              </div>
            </div>
            <div class="segmented merge-choices" role="group" aria-label={m.place(i + 1, places.length)}>
              {option(index, region.choice, 'theirs', m.useTheirs)}
              {option(index, region.choice, 'yours', m.useYours)}
              {option(index, region.choice, 'both', m.keepBoth)}
            </div>
          </li>
        ))}
      </ol>
      <div class="merge-footer">
        <p role="status">{left > 0 ? m.left(left) : m.allChosen}</p>
        <button type="button" class="primary" disabled={left > 0} onClick={onApply}>
          {m.apply}
        </button>
      </div>
    </section>
  );
}
