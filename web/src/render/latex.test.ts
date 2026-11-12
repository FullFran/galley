import { describe, expect, it } from 'vitest';
import { renderLatex } from './latex';
import { memoryProject } from './testProject';

const BIB = `
@article{benavente2024, author = {Benavente, J. F.}, year = {2024}, title = {Trapped charge}, journal = {Opt. Mater.}}
@book{chen1997, author = {Chen, R.}, year = {1997}, title = {Theory}, publisher = {WS}}
`;
const PNG = new Uint8Array([137, 80, 78, 71]);

const doc = (body: string, files: Record<string, string | Uint8Array> = {}) => renderLatex(memoryProject({ 'index.qmd': body, ...files }));
/** The LaTeX between `\begin{document}` and `\end{document}`. */
const inner = (tex: string) => tex.slice(tex.indexOf('\\begin{document}') + 16, tex.indexOf('\\end{document}'));
const body = async (src: string, files: Record<string, string | Uint8Array> = {}) => inner((await doc(src, files)).tex);

describe('document shell', () => {
  it('emits a plain article with a note when the project has no elsevier-pdf format', async () => {
    const r = await doc('Hello.');
    expect(r.tex).toContain('\\documentclass[]{article}');
    expect(r.tex).toContain('\\begin{document}');
    expect(r.tex).toContain('Hello.');
    expect(r.tex.trim().endsWith('\\end{document}')).toBe(true);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: 'info', message: expect.stringContaining('article') }));
  });

  it('uses elsarticle with the journal options of format.elsevier-pdf', async () => {
    const r = await renderLatex(
      memoryProject({
        '_quarto.yml': 'format:\n  elsevier-pdf:\n    journal:\n      formatting: preprint\n      model: 3p\n      cite-style: authoryear\n      name: Test Journal\n',
        'index.qmd': 'Hi.',
      }),
    );
    expect(r.tex).toContain('\\documentclass[\n  authoryear,\n  preprint,\n  3p]{elsarticle}');
    expect(r.tex).toContain('\\bibliographystyle{elsarticle-harv}');
    expect(r.tex).toContain('\\journal{Test Journal}');
    expect(r.diagnostics.some((d) => d.message.includes('article'))).toBe(false);
  });

  it('merges journal options from the front matter over the format section', async () => {
    const r = await renderLatex(
      memoryProject({
        '_quarto.yml': 'format:\n  elsevier-pdf:\n    journal:\n      model: 1p\n',
        'index.qmd': '---\njournal:\n  formatting: review\n---\nHi.',
      }),
    );
    expect(r.tex).toContain('number,\n  review,\n  1p]{elsarticle}');
    expect(r.tex).toContain('\\bibliographystyle{elsarticle-num}');
  });

  it('defaults to numbered citations and warns about an unknown cite-style', async () => {
    const r = await renderLatex(
      memoryProject({ '_quarto.yml': 'format:\n  elsevier-pdf:\n    journal:\n      cite-style: nope\n', 'index.qmd': 'Hi.' }),
    );
    expect(r.tex).toContain('number]{elsarticle}');
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('cite-style') }));
  });

  it('reports nothing to compile without an entry file', async () => {
    const r = await renderLatex(memoryProject({ 'notes.txt': 'x' }));
    expect(r.tex).toBe('');
    expect(r.diagnostics[0]?.severity).toBe('info');
  });
});

describe('front matter', () => {
  const front = `---
title: "Glow curves of *LiF*"
subtitle: "A subtitle"
author:
  - name: Ada Example
    email: ada@example.org
    attributes:
      corresponding: true
    affiliations:
      - ref: a1
  - name: Ben Sample
    affiliations:
      - ref: a1
      - ref: a2
affiliations:
  - id: a1
    name: Example University
    city: Granada
    country: Spain
  - id: a2
    name: Sample Institute
abstract: |
  A model with $n = 3$ traps.
keywords: [Thermoluminescence, Kinetic model]
journal:
  highlights:
    - A first highlight
---
Body.`;

  it('writes the elsarticle frontmatter block', async () => {
    const r = await renderLatex(memoryProject({ '_quarto.yml': 'format:\n  elsevier-pdf: {}\n', 'index.qmd': front }));
    const t = r.tex;
    expect(t).toContain('\\begin{frontmatter}');
    expect(t).toContain('\\title{Glow curves of \\emph{LiF} \\\\\\large{A subtitle}}');
    expect(t).toContain('\\author[1]{Ada Example\\corref{cor1}}\n\\ead{ada@example.org}');
    expect(t).toContain('\\author[1,2]{Ben Sample}');
    expect(t).toContain('\\affiliation[1]{organization={Example University},city={Granada},country={Spain},countrysep={,},postcodesep={}}');
    expect(t).toContain('\\affiliation[2]{organization={Sample Institute},postcodesep={}}');
    expect(t).toContain('\\cortext[cor1]{Corresponding author}');
    expect(t).toContain('\\begin{abstract}\nA model with \\(n = 3\\) traps.\n\\end{abstract}');
    expect(t).toContain('\\begin{highlights}\n\\item A first highlight\n\\end{highlights}');
    expect(t).toContain('\\begin{keyword}\n    Thermoluminescence \\sep\n    Kinetic model\n\\end{keyword}');
    expect(t).toContain('\\end{frontmatter}');
    expect(t).toContain('pdftitle={Glow curves of LiF}');
    expect(t.indexOf('\\end{frontmatter}')).toBeLessThan(t.indexOf('Body.'));
  });

  it('uses maketitle, abstract and keywords in the plain article', async () => {
    const t = (await doc(front)).tex;
    expect(t).toContain('\\title{Glow curves of \\emph{LiF}');
    expect(t).toContain('Ada Example\\textsuperscript{1}');
    expect(t).toContain('\\maketitle');
    expect(t).toContain('\\begin{abstract}');
    expect(t).toContain('Thermoluminescence');
  });
});

describe('escaping', () => {
  it('escapes the LaTeX specials in text', async () => {
    const b = await body('Cost 5% of $ & # _ ~ ^ \\ { } done\\_ here');
    expect(b).toContain('\\%');
    expect(b).toContain('\\&');
    expect(b).toContain('\\#');
    expect(b).toContain('\\_');
    expect(b).toContain('\\textasciitilde{}');
    expect(b).toContain('\\textasciicircum{}');
    expect(b).toContain('\\textbackslash{}');
    expect(b).toContain('\\{ \\}');
    expect(b).toContain('\\$');
  });

  it('keeps Unicode text that pdfLaTeX can typeset, maps common symbols and replaces the rest', async () => {
    const r = await doc('Caf\u00e9 \u2264 5 \u03bcm \u2192 \u4e2d done');
    const b = inner(r.tex);
    expect(b).toContain('Caf\u00e9');
    expect(b).toContain('\\ensuremath{\\leq}');
    expect(b).toContain('\\ensuremath{\\mu}m');
    expect(b).toContain('\\ensuremath{\\rightarrow}');
    expect(b).not.toContain('\u4e2d');
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('U+4E2D') }));
  });

  it('does not escape math', async () => {
    const b = await body('Inline $a_i^2 \\% x$ end.');
    expect(b).toContain('\\(a_i^2 \\% x\\)');
  });
});

describe('blocks', () => {
  it('maps heading levels, labels and unnumbered sections', async () => {
    const b = await body('# Intro {#sec-intro}\n\n## Sub {#sec-sub}\n\n### Third\n\n# Plain {.unnumbered}\n\n## Also {-}\n');
    expect(b).toContain('\\section{Intro}\\label{sec-intro}');
    expect(b).toContain('\\subsection{Sub}\\label{sec-sub}');
    expect(b).toContain('\\subsubsection{Third}');
    expect(b).toContain('\\section*{Plain}');
    expect(b).toContain('\\subsection*{Also}');
  });

  it('passes a raw latex \\appendix block through and drops raw html', async () => {
    const b = await body('Before.\n\n```{=latex}\n\\appendix\n```\n\n```{=html}\n<b>no</b>\n```\n\n# Extra\n');
    expect(b).toContain('\\appendix\n');
    expect(b).not.toContain('<b>');
    expect(b.indexOf('\\appendix')).toBeLessThan(b.indexOf('\\section{Extra}'));
  });

  it('passes raw inline latex through', async () => {
    const b = await body('A `\\textsc{small}`{=latex} word and `<b>x</b>`{=html} gone.');
    expect(b).toContain('A \\textsc{small} word and  gone.');
  });

  it('emits emphasis, strong, code, links and line breaks', async () => {
    const b = await body('*em* **strong** `a_b` [site](https://example.org/a%20b?x=1&y=2#top) [here](#sec-x) end\\\nnext');
    expect(b).toContain('\\emph{em}');
    expect(b).toContain('\\textbf{strong}');
    expect(b).toContain('\\texttt{a\\_b}');
    expect(b).toContain('\\href{https://example.org/a\\%20b?x=1&y=2\\#top}{site}');
    expect(b).toContain('\\hyperref[sec-x]{here}');
    expect(b).toContain('end\\\\\nnext');
  });

  it('emits lists, quotes and verbatim code', async () => {
    const b = await body('- one\n- two\n\n3. three\n4. four\n\n> quoted\n\n```python\nprint("a_b")\n```\n');
    expect(b).toContain('\\begin{itemize}\n\\item one\n\\item two\n\\end{itemize}');
    expect(b).toContain('\\begin{enumerate}\n\\setcounter{enumi}{2}\n\\item three\n\\item four\n\\end{enumerate}');
    expect(b).toContain('\\begin{quote}\nquoted\n\\end{quote}');
    expect(b).toContain('\\begin{verbatim}\nprint("a_b")\n\\end{verbatim}');
  });

  it('emits footnotes in place', async () => {
    const b = await body('Text[^1] more.\n\n[^1]: The *note*.\n');
    expect(b).toContain('Text\\footnote{The \\emph{note}.} more.');
    expect(b).not.toContain('[^1]');
  });

  it('emits callouts as titled quotes', async () => {
    const b = await body('::: {.callout-warning}\nBe careful.\n:::\n\n::: {.callout-note title="Custom"}\nText.\n:::\n');
    expect(b).toContain('\\begin{quote}\n\\textbf{Warning}\\par\nBe careful.\n\\end{quote}');
    expect(b).toContain('\\textbf{Custom}\\par');
  });

  it('emits plain divs as their content', async () => {
    const b = await body('::: {.custom}\nInside.\n:::\n');
    expect(b).toContain('Inside.');
    expect(b).not.toContain('custom');
  });
});

describe('math', () => {
  it('labels display equations and leaves unlabelled ones as \\[ \\]', async () => {
    const b = await body('$$x = 1$$ {#eq-one}\n\n$$y = 2$$\n\n$$\nz = 3\n$$ {#eq-three}\n');
    expect(b).toContain('\\begin{equation}\\label{eq-one}x = 1\\end{equation}');
    expect(b).toContain('\\[y = 2\\]');
    expect(b).toContain('\\begin{equation}\\label{eq-three}\nz = 3\n\\end{equation}');
  });

  it('does not wrap a content that already opens an align-like environment', async () => {
    const b = await body('$$\n\\begin{align}\na &= 1 \\\\\nb &= 2\n\\end{align}\n$$\n');
    expect(b).not.toContain('\\begin{equation}');
    expect(b).not.toContain('\\[');
    expect(b).toContain('\\begin{align}');
  });
});

describe('citations and cross-references', () => {
  const files = { 'references.bib': BIB, '_quarto.yml': 'bibliography: references.bib\ncrossref:\n  fig-prefix: Fig.\n  tbl-prefix: Table\n  eq-prefix: Eq.\n  sec-prefix: Section\n' };
  const ref = (s: string) =>
    body(`${s}\n\n# Heading {#sec-h}\n\n![Cap.](f.png){#fig-a}\n\n$$x$$ {#eq-b}\n\n| a |\n|---|\n| b |\n\n: Tab. {#tbl-c}\n`, { ...files, 'f.png': PNG });

  it('maps bracketed and in-text citations (authoryear style)', async () => {
    const r = await renderLatex(
      memoryProject({
        ...files,
        '_quarto.yml': `${files['_quarto.yml']}format:\n  elsevier-pdf:\n    journal:\n      cite-style: authoryear\n`,
        'index.qmd': 'A [@benavente2024; @chen1997], @benavente2024 says, [-@chen1997], [see @chen1997, p. 3], [@benavente2024; -@chen1997].',
      }),
    );
    const b = inner(r.tex);
    expect(b).toContain('\\citep{benavente2024,chen1997}');
    expect(b).toContain('\\citet{benavente2024} says');
    expect(b).toContain('\\citeyearpar{chen1997}');
    expect(b).toContain('\\citep[see][p.~3]{chen1997}');
    expect(b).toContain('\\citetext{\\citealp{benavente2024}; \\citeyear{chen1997}}');
  });

  it('forces parenthetical citations for numbered styles', async () => {
    const b = await body('@benavente2024 shows.', { ...files, '_quarto.yml': `${files['_quarto.yml']}format:\n  elsevier-pdf: {}\n` });
    expect(b).toContain('\\citep{benavente2024} shows.');
  });

  it('warns about a citation without a bibliography entry', async () => {
    const r = await doc('See [@ghost].', files);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', message: 'No bibliography entry for @ghost' }));
  });

  it('maps cross-references with the configured prefixes', async () => {
    const b = await ref('See @fig-a, @tbl-c, @sec-h and @eq-b; numbers [-@fig-a], [-@eq-b], [-@sec-h]; [see @fig-a, p. 2]; [@fig-a; @tbl-c].');
    expect(b).toContain('Fig.~\\ref{fig-a}');
    expect(b).toContain('Table~\\ref{tbl-c}');
    expect(b).toContain('Section~\\ref{sec-h}');
    expect(b).toContain('Eq.~(\\ref{eq-b})');
    expect(b).toContain('numbers \\ref{fig-a}, \\ref{eq-b}, \\ref{sec-h}');
    expect(b).toContain('see Fig.~\\ref{fig-a}, p. 2');
    expect(b).toContain('Fig.~\\ref{fig-a}, Table~\\ref{tbl-c}');
  });

  it('flags an unknown cross-reference', async () => {
    const r = await doc('See @fig-missing.');
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', message: 'Unknown cross-reference @fig-missing' }));
    expect(inner(r.tex)).toContain('\\textbf{?@fig-missing}');
  });

  it('writes the bibliography without the extension and returns the file', async () => {
    const r = await doc('Cite @chen1997.\n\n# References {.unnumbered}\n\n::: {#refs}\n:::\n', files);
    expect(r.tex).toContain('\\section*{References}');
    expect(r.tex).toContain('\\renewcommand{\\bibsection}{}\n\\bibliography{references}');
    expect(r.tex).not.toContain('references.bib');
    expect(r.files.map((f) => f.path)).toContain('references.bib');
    const bib = r.files.find((f) => f.path === 'references.bib');
    expect(new TextDecoder().decode(bib?.bytes)).toContain('chen1997');
  });

  it('appends the bibliography at the end when there is no refs div', async () => {
    const r = await doc('Cite @chen1997.', files);
    expect(r.tex).toMatch(/\\bibliography\{references\}\s*\\end\{document\}/);
    expect(r.tex).not.toContain('\\renewcommand{\\bibsection}');
  });

  it('keeps a subdirectory in the bibliography name and skips non-bib files', async () => {
    const r = await doc('Cite @chen1997.', { 'refs/lit.bib': BIB, 'refs/lit.json': '[]', '_quarto.yml': 'bibliography:\n  - refs/lit.bib\n  - refs/lit.json\n' });
    expect(r.tex).toContain('\\bibliography{refs/lit}');
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('refs/lit.json') }));
  });
});

describe('tables', () => {
  const table = '| Name | Count |\n|:--|--:|\n| Peaks $T_m$ | 5 |\n| Rest | 7 |\n';
  it('emits a captioned longtable with booktabs', async () => {
    const b = await body(`${table}\n: Free parameters. {#tbl-p}\n`);
    expect(b).toContain('\\begin{longtable}[]{@{}lr@{}}');
    expect(b).toContain('\\caption{Free parameters.}\\label{tbl-p}\\tabularnewline');
    expect(b).toContain('\\toprule\\noalign{}\nName & Count \\\\\n\\midrule\\noalign{}\n\\endfirsthead');
    expect(b).toContain('\\endhead\n\\bottomrule\\noalign{}\n\\endlastfoot');
    expect(b).toContain('Peaks \\(T_m\\) & 5 \\\\');
    expect(b).toContain('\\end{longtable}');
  });

  it('omits the caption block for an uncaptioned table', async () => {
    const b = await body(table);
    expect(b).not.toContain('\\caption');
    expect(b).toContain('\\begin{longtable}[]{@{}lr@{}}\n\\toprule\\noalign{}');
  });

  it('uses fixed-width columns for wide cells', async () => {
    const b = await body('| A | B |\n|---|---|\n| ' + 'long words '.repeat(8) + '| short |\n');
    expect(b).toContain('>{\\raggedright\\arraybackslash}p{(\\linewidth - 2\\tabcolsep) * \\real{');
  });

  it('puts a table caption div in a float', async () => {
    const b = await body(`::: {#tbl-d}\n${table}\nA caption.\n:::\n`);
    expect(b).toContain('\\begin{table}');
    expect(b).toContain('\\begin{tabular}{@{}lr@{}}');
    expect(b).toContain('\\caption{\\label{tbl-d}A caption.}');
    expect(b).not.toContain('longtable');
  });
});

describe('figures', () => {
  it('emits a float with width, caption and label', async () => {
    const r = await doc('![The *scheme*.](figures/s.png){#fig-s width=50%}\n', { 'figures/s.png': PNG });
    const b = inner(r.tex);
    expect(b).toContain('\\begin{figure}\n\\centering\n\\includegraphics[width=0.5\\linewidth,height=\\textheight,keepaspectratio]{figures/s.png}\n\\caption{\\label{fig-s}The \\emph{scheme}.}\n\\end{figure}');
    expect(r.files).toEqual([expect.objectContaining({ path: 'figures/s.png', bytes: PNG })]);
  });

  it('prefers a pdf sibling for extensionless sources and bounds the size without width', async () => {
    const r = await doc('![Cap.](figures/s){#fig-s}\n', { 'figures/s.png': PNG, 'figures/s.pdf': PNG });
    expect(inner(r.tex)).toContain('\\pandocbounded{\\includegraphics[keepaspectratio]{figures/s.pdf}}');
    expect(r.files.map((f) => f.path)).toEqual(['figures/s.pdf']);
  });

  it('resolves figures relative to the entry file directory', async () => {
    const r = await renderLatex(
      memoryProject({ '_quarto.yml': 'project:\n  render:\n    - paper/index.qmd\n', 'paper/index.qmd': '![C](img/a.jpg)\n', 'paper/img/a.jpg': PNG }),
    );
    expect(inner(r.tex)).toContain('{paper/img/a.jpg}');
    expect(r.files.map((f) => f.path)).toEqual(['paper/img/a.jpg']);
  });

  it('replaces an SVG with a PNG sibling, or a placeholder with a diagnostic', async () => {
    const sibling = await doc('![C](a.svg)\n\n![D](b.svg)\n', { 'a.svg': '<svg/>', 'a.png': PNG, 'b.svg': '<svg/>' });
    const b = inner(sibling.tex);
    expect(b).toContain('{a.png}');
    expect(b).not.toContain('a.svg}');
    expect(b).toContain('\\fbox{');
    expect(b).toContain('b.svg');
    expect(sibling.files.map((f) => f.path)).toEqual(['a.png']);
    expect(sibling.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('b.svg') }));
  });

  it('emits a placeholder for a missing image', async () => {
    const r = await doc('![C](nope.png){#fig-n}\n');
    expect(inner(r.tex)).toContain('\\fbox{');
    expect(inner(r.tex)).toContain('\\label{fig-n}');
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', message: 'Image not found: nope.png' }));
  });

  it('emits a captioned div with its image as one figure', async () => {
    const b = await body('::: {#fig-d}\n![](a.png)\n\nThe caption.\n:::\n', { 'a.png': PNG });
    expect(b).toContain('\\begin{figure}\n\\centering\n');
    expect(b).toContain('\\caption{\\label{fig-d}The caption.}\n\\end{figure}');
    expect(b.match(/\\begin\{figure\}/g)).toHaveLength(1);
  });
});

describe('includes', () => {
  it('expands includes and keeps the order', async () => {
    const r = await doc('{{< include a.qmd >}}\n\nAfter.', { 'a.qmd': '# From a\n' });
    const b = inner(r.tex);
    expect(b.indexOf('\\section{From a}')).toBeLessThan(b.indexOf('After.'));
  });
});
