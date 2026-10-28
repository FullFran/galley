import { describe, expect, it } from 'vitest';
import { render } from './index';
import { memoryProject } from './testProject';

// A synthetic project with the structure of the first real paper: _quarto.yml
// with crossref prefixes and the bibliography, an index.qmd holding only front
// matter and includes, one file per section, a raw LaTeX \appendix block and a
// refs div. The text is invented; no paper text is copied.
const raw = import.meta.glob<string>('./fixtures/paper/**/*', { query: '?raw', import: 'default', eager: true });
const files = Object.fromEntries(Object.entries(raw).map(([path, text]) => [path.replace('./fixtures/paper/', ''), text]));

describe('paper-shaped fixture', () => {
  it('renders the whole project with numbering, citations and references', async () => {
    const project = memoryProject(files);
    const { html, assets, diagnostics } = await render(project);
    expect(diagnostics).toEqual([]);
    expect(html).toContain('A synthetic model of glow curves in LiF:Mg,Ti');
    expect(html).toContain('Example University, Granada, Spain');
    expect(html).not.toContain('Highlights are printed');
    expect(html).not.toContain('internal note');

    const flat = html.replace(/<[^>]+>/g, '').replace(/&nbsp;|\u00a0/g, ' ');
    expect(flat).toContain('The model of Benavente et al. (2024) is reused here (Chen and McKeever, 1997; Randall and Wilkins, 1945).');
    expect(flat).toContain('The scheme is shown in Fig. 1 and the parameters in Table 1.');
    expect(flat).toContain('Rates follow Eq. (1), derived in Appendix A.1.');
    expect(flat).toContain('See Section 2.1 and Eq. (1).');
    expect(flat).toContain('Figure 1: Energy-band scheme');
    expect(flat).toContain('Table 1: Free parameters.');
    expect(flat).toMatch(/References[\s\S]*Benavente, J\.F\.[\s\S]*Chen, R\.[\s\S]*Randall, J\.T\./);

    expect(assets).toEqual([expect.objectContaining({ path: 'figures/fig1_scheme.png', type: 'image/png' })]);
    expect(project.reads).toContain('sections/A-appendix.qmd');
  });
});
