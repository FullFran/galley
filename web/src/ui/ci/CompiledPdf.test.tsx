import { render } from 'preact-render-to-string';
import { describe, expect, it, vi } from 'vitest';
import type { Repository } from '../../domain';
import type { CiGateway, DocumentsResult } from '../../github/ci';
import { I18n } from '../../i18n';
import { es } from '../../i18n/es';
import { CompiledPdfView } from './CompiledPdf';

const repo: Repository = { id: 7, owner: 'octo', name: 'paper', fullName: 'octo/paper', defaultBranch: 'main', private: true };

describe('compiled PDF view', () => {
  it('says the PDF is not available without a CI gateway (the demo), with no buttons', () => {
    const html = render(<CompiledPdfView repo={repo} />);
    expect(html).toContain('data-pdf-state="unavailable"');
    expect(html).toContain('The compiled PDF is not available here');
    expect(html).toContain('PDF of main');
    expect(html).not.toContain('data-pdf-refresh');
    expect(html).not.toContain('<iframe');
  });

  it('shows the loading state first with a CI gateway, in Spanish too', () => {
    const ci: CiGateway = { status: vi.fn(), documents: vi.fn(() => new Promise<DocumentsResult>(() => undefined)) };
    const html = render(
      <I18n.Provider value={es}>
        <CompiledPdfView ci={ci} repo={repo} />
      </I18n.Provider>,
    );
    expect(html).toContain('data-pdf-state="loading"');
    expect(html).toContain('Obteniendo el PDF compilado de main de GitHub');
  });
});
