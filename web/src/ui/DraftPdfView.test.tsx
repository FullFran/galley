import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { DraftPdfView } from './DraftPdfView';
import type { Diagnostic } from '../render';

describe('DraftPdfView', () => {
  it('shows first-time engine download message while compiling initially', () => {
    const html = render(<DraftPdfView compiling firstCompile notes={[]} />);
    expect(html).toContain('Downloading the PDF engine (~32 MB, once)');
    expect(html).toContain('Draft PDF compiled in the browser · The CI PDF is the official copy');
  });

  it('shows Compiling… when compiling without first-time note', () => {
    const html = render(<DraftPdfView compiling firstCompile={false} notes={[]} />);
    expect(html).toContain('Compiling…');
    expect(html).not.toContain('Downloading the PDF engine');
  });

  it('renders notes list under the PDF when notes are present', () => {
    const notes: Diagnostic[] = [
      { severity: 'error', message: '! Undefined control sequence.' },
      { severity: 'warning', message: 'Missing figure' },
    ];
    const html = render(<DraftPdfView compiling={false} notes={notes} />);
    expect(html).toContain('preview-notes');
    expect(html).toContain('! Undefined control sequence.');
    expect(html).toContain('Missing figure');
  });

  it('renders the official draft notice', () => {
    const html = render(<DraftPdfView compiling={false} notes={[]} />);
    expect(html).toContain('The CI PDF is the official copy');
  });
});
