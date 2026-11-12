import { describe, expect, it } from 'vitest';
import { renderLatex } from './latex';
import { memoryProject } from './testProject';

// Compares the LaTeX of the paper-shaped fixture with the structures of
// fixtures/quarto-elsevier-reference.tex (Quarto 1.9 + pandoc 3.9). The
// fixture configures authoryear / preprint / 1p, which the reference run did
// not pick up, so class options and the bibliography style follow the
// quarto-journals/elsevier extension rather than the reference.
const raw = import.meta.glob<string>('./fixtures/paper/**/*', { query: '?raw', import: 'default', eager: true });
const files = Object.fromEntries(Object.entries(raw).map(([path, text]) => [path.replace('./fixtures/paper/', ''), text]));
const reference = import.meta.glob<string>('./fixtures/quarto-elsevier-reference.tex', { query: '?raw', import: 'default', eager: true });

describe('elsarticle LaTeX of the paper-shaped fixture', () => {
  it('has the structures of the Quarto reference', async () => {
    const r = await renderLatex(memoryProject(files));
    const t = r.tex;
    expect(r.diagnostics).toEqual([]);

    expect(t).toContain('\\documentclass[\n  authoryear,\n  preprint,\n  1p]{elsarticle}');
    expect(t).toContain('\\usepackage[]{natbib}');
    expect(t).toContain('\\bibliographystyle{elsarticle-harv}');
    expect(t).toContain('\\title{A synthetic model of glow curves in LiF:Mg,Ti}');
    expect(t).toContain('\\author[1]{Ada Example}');
    expect(t).toContain('\\author[1,2]{Ben Sample}');
    expect(t).toContain('\\affiliation[1]{organization={Example University},city={Granada},country={Spain},countrysep={,},postcodesep={}}');
    expect(t).toContain('\\affiliation[2]{organization={Sample Institute},postcodesep={}}');
    expect(t).toContain('\\begin{abstract}\nA kinetic model has been fitted to a synthetic curve with \\(n = 3\\) traps.\n\\end{abstract}');
    expect(t).toContain('\\begin{highlights}\n\\item Highlights are printed only in the PDF\n\\end{highlights}');
    expect(t).toContain('Thermoluminescence \\sep\n    Kinetic model');
    expect(t).not.toContain('internal note');

    expect(t).toContain('\\section{Introduction}\\label{sec-intro}');
    expect(t).toContain('\\subsection{Band model}\\label{sec-band}');
    expect(t).toContain('The model of \\citet{benavente2024} is reused here \\citep{randall1945,chen1997}.');
    expect(t).toContain('Fig.~\\ref{fig-scheme}');
    expect(t).toContain('Table~\\ref{tbl-params}');
    expect(t).toContain('Rates follow Eq. (\\ref{eq-rate}), derived in \\ref{sec-app-inversion}.');
    expect(t).toContain('See Section~\\ref{sec-band} and Eq.~(\\ref{eq-rate}).');

    expect(t).toContain('\\includegraphics[width=1\\linewidth,height=\\textheight,keepaspectratio]{figures/fig1_scheme.png}');
    expect(t).toContain('\\caption{\\label{fig-scheme}Energy-band scheme with traps \\(i = 1, \\ldots, 5\\).}');
    expect(t).toContain('\\begin{equation}\\label{eq-rate}p_i = s_i \\exp\\left(-\\frac{E_i}{k_B T}\\right)\\end{equation}');
    expect(t).toContain('\\begin{longtable}[]{@{}ll@{}}\n\\caption{Free parameters.}\\label{tbl-params}\\tabularnewline');
    expect(t).toContain('Peak temperatures \\(T_{m,i}\\) & 5 \\\\');

    expect(t).toContain('\\appendix\n');
    expect(t.indexOf('\\appendix')).toBeLessThan(t.indexOf('\\section{Derivations}\\label{sec-appendix}'));
    expect(t).toContain('\\subsection{Inversion of the closure}\\label{sec-app-inversion}');
    expect(t).toContain('\\section*{References}');
    expect(t).toContain('\\renewcommand{\\bibsection}{}\n\\bibliography{references}');
    expect(t).not.toContain('references.bib');
    expect(t.trim().endsWith('\\end{document}')).toBe(true);

    expect(r.files.map((f) => f.path).sort()).toEqual(['figures/fig1_scheme.png', 'references.bib']);
  });

  it('shares its preamble with the reference', async () => {
    const ref = Object.values(reference)[0] ?? '';
    const t = (await renderLatex(memoryProject(files))).tex;
    for (const line of [
      '\\usepackage{amsmath,amssymb}',
      '\\usepackage[T1]{fontenc}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage{longtable,booktabs,array}',
      '\\usepackage{graphicx}',
      '\\usepackage{bookmark}',
      '\\def\\fps@figure{htbp}',
      '\\setlength{\\parindent}{6pt}',
    ]) {
      expect(ref).toContain(line);
      expect(t).toContain(line);
    }
  });
});
