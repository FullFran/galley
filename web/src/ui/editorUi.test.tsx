import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { UpstreamBanner } from './UpstreamBanner';
import { EditorModeSwitch } from './EditorModeSwitch';
import { FigureView } from './FigureLightbox';
import { MergeResolver } from './MergeResolver';
import type { MergeRegion } from '../workspace/merge3';

const noop = () => undefined;

describe('UpstreamBanner', () => {
  it('offers to bring in the new changes of the default branch, with a dismiss', () => {
    const html = render(<UpstreamBanner state={{ kind: 'behind', behind: 3, branch: 'main', busy: false }} onBringIn={noop} onDismiss={noop} />);
    expect(html).toContain('main has 3 new changes');
    expect(html).toContain('Bring them in');
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).toContain('role="status"');
  });

  it('says it is busy while bringing them in', () => {
    const html = render(<UpstreamBanner state={{ kind: 'behind', behind: 1, branch: 'main', busy: true }} onBringIn={noop} onDismiss={noop} />);
    expect(html).toContain('main has 1 new change');
    expect(html).toContain('Bringing them in…');
    expect(html).toContain('disabled');
  });

  it('explains a conflict and links to GitHub, without blocking', () => {
    const html = render(
      <UpstreamBanner state={{ kind: 'conflict', url: 'https://github.com/o/p/compare/main...galley/ana' }} onBringIn={noop} onDismiss={noop} />,
    );
    expect(html).toContain('Your proposal conflicts with the latest version; ask an admin or resolve on GitHub.');
    expect(html).toContain('href="https://github.com/o/p/compare/main...galley/ana"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('role="alert"');
  });

  it('asks for a choice where both sides changed the same lines, with a way to review', () => {
    const html = render(<UpstreamBanner state={{ kind: 'choose', files: ['a.qmd'] }} onBringIn={noop} onReview={noop} onDismiss={noop} />);
    expect(html).toContain('You and the latest version changed the same lines in a.qmd. Choose which text to keep before saving.');
    expect(html).toContain('>Review<');
    expect(html).not.toContain('Dismiss');
  });
});

describe('MergeResolver', () => {
  const regions: MergeRegion[] = [
    { kind: 'ok' as const, text: 'Intro\n' },
    { kind: 'conflict' as const, yours: 'My sentence.\n', theirs: 'Their sentence.\n' },
  ];

  it('shows both versions side by side with plain choices and no conflict markers', () => {
    const html = render(<MergeResolver path="a.qmd" branch="main" regions={regions} onChange={noop} onApply={noop} />);
    expect(html).toContain('Choose which text to keep in a.qmd');
    expect(html).toContain('Their version (main)');
    expect(html).toContain('Your version');
    expect(html).toContain('Their sentence.');
    expect(html).toContain('My sentence.');
    expect(html).toContain('Keep both');
    expect(html).not.toMatch(/<{7}|>{7}|={7}/);
    expect(html).toContain('1 place left to choose');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Use this text</);
  });

  it('marks the choice and enables applying once every place has one', () => {
    const chosen: MergeRegion[] = [regions[0] as MergeRegion, { kind: 'conflict', yours: 'My sentence.\n', theirs: 'Their sentence.\n', choice: 'both' }];
    const html = render(<MergeResolver path="a.qmd" branch="main" regions={chosen} onChange={noop} onApply={noop} />);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Keep both</);
    expect(html).toContain('All places chosen');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Use this text</);
  });
});

describe('EditorModeSwitch', () => {
  it('shows Writing | Code with the current mode pressed', () => {
    const html = render(<EditorModeSwitch mode="writing" onMode={noop} />);
    expect(html).toContain('aria-label="Editor mode"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Writing</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Code</);
  });
});

describe('FigureView', () => {
  it('shows an image figure from a data URL with its path as the name', () => {
    const html = render(<FigureView path="figures/a.png" state={{ kind: 'ready', url: 'data:image/png;base64,AAAA' }} />);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('alt="figures/a.png"');
  });

  it('explains PDF figures and failures', () => {
    expect(render(<FigureView path="figures/a.pdf" state={{ kind: 'pdf' }} />)).toContain('PDF figures are not shown here');
    expect(render(<FigureView path="figures/a.png" state={{ kind: 'failed' }} />)).toContain('could not be loaded');
    expect(render(<FigureView path="figures/a.png" state={{ kind: 'too-large' }} />)).toContain('too large to show here');
  });
});
