import { describe, expect, it } from 'vitest';
import { render } from './index';
import { memoryProject } from './testProject';

/** Visible text of an HTML fragment, with KaTeX's MathML annotations removed. */
function text(html: string): string {
  return html
    .replace(/<annotation[\s\S]*?<\/annotation>/g, '')
    .replace(/<span class="katex-html"[\s\S]*?<\/span><\/span><\/span>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

const doc = (body: string, files: Record<string, string | Uint8Array> = {}) =>
  render(memoryProject({ 'index.qmd': body, ...files }));

const BIB = `
@article{benavente2024,
  author = {Benavente, J. F. and Arquero, O. and Berenguer-Antequera, J.},
  year = {2024}, title = {Effects of trapped charge transitions},
  journal = {Opt. Mater.}, volume = {156}, pages = {116006}
}
@book{chen1997,
  author = {Chen, R. and McKeever, S. W. S.}, year = {1997},
  title = {Theory of Thermoluminescence}, publisher = {World Scientific}, address = {Singapore}
}
@article{randall1945,
  author = {Randall, J. T. and Wilkins, M. H. F.}, year = {1945},
  title = {Phosphorescence and electron traps}, journal = {Proc. R. Soc. Lond. A},
  volume = {184}, pages = {366--389}
}
`;

describe('front matter', () => {
  it('renders title, authors with affiliations, abstract and keywords', async () => {
    const { html, diagnostics } = await doc(`---
title: "Glow curves of *LiF*"
author:
  - name: Ada Example
    affiliations:
      - ref: a1
  - name:
      given: Ben
      family: Sample
    affiliations:
      - ref: a2
affiliations:
  - id: a1
    name: Example University
    country: Spain
  - id: a2
    name: Sample Institute
abstract: |
  A model has been **fitted** with $n = 3$ traps.
keywords: [Thermoluminescence, Kinetics]
---

Body.
`);
    expect(diagnostics).toEqual([]);
    expect(html).toContain('<h1 class="title">Glow curves of <em>LiF</em></h1>');
    expect(html).toContain('<span class="author">Ada Example<sup>a</sup></span>, <span class="author">Ben Sample<sup>b</sup></span>');
    expect(html).toContain('<sup>a</sup>Example University, Spain');
    expect(html).toContain('<sup>b</sup>Sample Institute');
    expect(html).toMatch(/<section class="abstract">[\s\S]*<strong>fitted<\/strong>[\s\S]*class="katex"/);
    expect(text(html)).toContain('Keywords: Thermoluminescence, Kinetics');
  });

  it('reports invalid YAML without failing the render', async () => {
    const { html, diagnostics } = await doc('---\ntitle: [unclosed\n---\n\nStill here.\n');
    expect(html).toContain('Still here.');
    expect(diagnostics[0]?.message).toMatch(/front matter/i);
  });
});

describe('numbering and cross-references', () => {
  const body = `# Introduction {#sec-intro}

See @sec-sub, @fig-a, @tbl-a and @eq-a. Short forms: [-@fig-a], Eq. ([-@eq-a]).

## Details {#sec-sub}

![A caption with $x^2$.](figures/a){#fig-a width=50%}

$$E = mc^2$$ {#eq-a}

| A | B |
|---|---|
| 1 | 2 |

: Parameters. {#tbl-a}

# Second {#sec-two}

![Second figure.](figures/b.png){#fig-b}

$$
a + b
$$ {#eq-b}

# Unnumbered {.unnumbered}
`;
  const files = {
    'figures/a.png': new Uint8Array([1]),
    'figures/b.png': new Uint8Array([2]),
  };

  it('numbers sections, figures, tables and equations', async () => {
    const { html } = await doc(body, files);
    expect(html).toMatch(/<h2 id="sec-intro"[^>]*><span class="header-section-number">1<\/span>/);
    expect(html).toMatch(/<h3 id="sec-sub"[^>]*><span class="header-section-number">1.1<\/span>/);
    expect(html).toMatch(/<h2 id="sec-two"[^>]*><span class="header-section-number">2<\/span>/);
    expect(html).not.toMatch(/header-section-number">3/);
    expect(text(html)).toContain('Figure 1: A caption with');
    expect(text(html)).toContain('Figure 2: Second figure.');
    expect(text(html)).toContain('Table 1: Parameters.');
    expect(html).toMatch(/id="eq-a"[\s\S]*?<span class="eq-number">\(1\)<\/span>/);
    expect(html).toMatch(/id="eq-b"[\s\S]*?<span class="eq-number">\(2\)<\/span>/);
  });

  it('renders cross-references with Quarto default prefixes and suppressed forms', async () => {
    const { html, diagnostics } = await doc(body, files);
    expect(diagnostics).toEqual([]);
    const t = text(html);
    expect(t).toContain('See Section 1.1, Figure 1, Table 1 and Equation (1).');
    expect(t).toContain('Short forms: 1, Eq. (1).');
    expect(html).toContain('<a class="crossref" href="#fig-a">');
  });

  it('uses the crossref prefixes from _quarto.yml', async () => {
    const quarto = 'crossref:\n  fig-prefix: Fig.\n  eq-prefix: Eq.\n  sec-prefix: Sec.\n';
    const { html } = await doc(body, { ...files, '_quarto.yml': quarto });
    expect(text(html)).toContain('See Sec. 1.1, Fig. 1, Table 1 and Eq. (1).');
  });

  it('flags unknown references instead of failing', async () => {
    const { html, diagnostics } = await doc('See @fig-missing.\n');
    expect(text(html)).toContain('?@fig-missing');
    expect(diagnostics).toEqual([expect.objectContaining({ message: expect.stringContaining('fig-missing') })]);
  });

  // elsarticle's \appendix makes section numbers "Appendix A", "Appendix A.1"
  // and equations "(A.1)", and a reference prints the whole number.
  it('switches to appendix numbering after a raw LaTeX \\appendix block', async () => {
    const { html } = await doc(
      '# Main {#sec-main}\n\n```{=latex}\n\\appendix\n```\n\n# Derivations {#sec-app}\n\n## Inversion {#sec-app-inv}\n\n$$x$$ {#eq-app}\n\nSee [-@sec-app-inv] and @eq-app.\n',
    );
    expect(html).toMatch(/id="sec-app"[^>]*><span class="header-section-number">Appendix A<\/span>/);
    expect(html).toMatch(/id="sec-app-inv"[^>]*><span class="header-section-number">Appendix A.1<\/span>/);
    expect(text(html)).toContain('See Appendix A.1 and Equation (A.1).');
    expect(html).not.toContain('\\appendix');
  });

  it('sends figures as assets and never as an inline src', async () => {
    const { html, assets } = await doc(body, files);
    expect(assets.map((a) => [a.path, a.type])).toEqual([
      ['figures/a.png', 'image/png'],
      ['figures/b.png', 'image/png'],
    ]);
    expect(html).toMatch(/<img data-galley-asset="a0" alt="A caption with x\^2." data-galley-css="width: 50%">/);
    expect(html).not.toMatch(/<img[^>]* src=/);
  });
});

describe('includes', () => {
  it('resolves nested includes relative to the including file', async () => {
    const { html, diagnostics } = await doc('{{< include sections/one.qmd >}}\n', {
      'sections/one.qmd': '# One {#sec-one}\n\n{{< include two.qmd >}}\n',
      'sections/two.qmd': 'Text from two, see @sec-one.\n',
    });
    expect(diagnostics).toEqual([]);
    expect(text(html)).toContain('Text from two, see Section 1.');
  });

  it('stops at include cycles and reports them', async () => {
    const { html, diagnostics } = await doc('Start.\n\n{{< include a.qmd >}}\n', {
      'a.qmd': 'In a.\n\n{{< include b.qmd >}}\n',
      'b.qmd': 'In b.\n\n{{< include a.qmd >}}\n',
    });
    expect(text(html)).toContain('In a.');
    expect(text(html)).toContain('In b.');
    expect(diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/cycle.*a\.qmd/i)]);
  });

  it('reports missing includes', async () => {
    const { diagnostics } = await doc('{{< include nope.qmd >}}\n');
    expect(diagnostics[0]?.message).toMatch(/nope\.qmd/);
  });
});

describe('citations', () => {
  const files = { 'refs.bib': BIB };
  const front = '---\nbibliography: refs.bib\n---\n\n';

  // The style sorts the items of a citation by author, as Quarto's HTML output does.
  it('renders author-year citations with the Elsevier Harvard style', async () => {
    const { html, diagnostics } = await doc(
      `${front}The model of @benavente2024 [@randall1945; @chen1997], also [-@chen1997] and [see @chen1997, p. 12].\n`,
      files,
    );
    expect(diagnostics).toEqual([]);
    expect(text(html)).toContain(
      'The model of Benavente et al. (2024) (Chen and McKeever, 1997; Randall and Wilkins, 1945), also (1997) and (see Chen and McKeever, 1997, p. 12).',
    );
  });

  it('lists the cited references where the refs div is', async () => {
    const { html } = await doc(`${front}Cite [@chen1997; @benavente2024].\n\n# References {.unnumbered}\n\n::: {#refs}\n:::\n\nAfter.\n`, files);
    const refs = html.slice(html.indexOf('id="refs"'), html.indexOf('After.'));
    expect(text(refs)).toContain('Benavente, J.F., Arquero, O., Berenguer-Antequera, J., 2024. Effects of trapped charge transitions. Opt. Mater. 156, 116006.');
    expect(text(refs)).toContain('Chen, R., McKeever, S.W.S., 1997. Theory of Thermoluminescence. World Scientific, Singapore.');
    expect(refs).not.toContain('Randall');
    expect(refs.indexOf('Benavente')).toBeLessThan(refs.indexOf('Chen'));
  });

  it('appends a References section when there is no refs div', async () => {
    const { html } = await doc(`${front}Cite @chen1997.\n`, files);
    expect(html).toMatch(/<h2[^>]*>References<\/h2>[\s\S]*Chen, R\./);
  });

  it('reports unknown keys and a missing bibliography', async () => {
    const missingKey = await doc(`${front}See @nobody2020.\n`, files);
    expect(text(missingKey.html)).toContain('?nobody2020');
    expect(missingKey.diagnostics[0]?.message).toMatch(/nobody2020/);
    const missingBib = await doc('---\nbibliography: gone.bib\n---\n\nSee @chen1997.\n');
    expect(missingBib.diagnostics.map((d) => d.message).join(' ')).toMatch(/gone\.bib/);
  });

  it('does not treat e-mail addresses as citations', async () => {
    const { html, diagnostics } = await doc('Write to ada@example.org.\n');
    expect(diagnostics).toEqual([]);
    expect(text(html)).toContain('Write to ada@example.org.');
  });
});

describe('other Quarto syntax', () => {
  it('renders callouts and footnotes', async () => {
    const { html } = await doc('::: {.callout-note}\n## Heads up\nCheck this.\n:::\n\nA claim.^[A footnote.]\n');
    expect(html).toMatch(/<div class="callout callout-note">[\s\S]*Heads up[\s\S]*Check this\./);
    expect(html).toMatch(/class="footnote-ref"/);
    expect(text(html)).toContain('A footnote.');
  });

  it('drops HTML comments, including inside table cells', async () => {
    const { html } = await doc('Text <!-- hidden --> here.\n\n| A |\n|---|\n| 1 <!-- note --> |\n');
    expect(html).not.toContain('hidden');
    expect(html).not.toContain('note');
    expect(text(html)).toContain('Text here.');
  });

  it('degrades unknown syntax with diagnostics', async () => {
    const { html, diagnostics } = await doc('{{< video demo.mp4 >}}\n\n```{=html}\n<b>raw</b>\n```\n\n```{python}\nprint(1)\n```\n');
    expect(html).not.toContain('<b>raw</b>');
    expect(html).toContain('print(1)');
    expect(diagnostics.map((d) => d.message).join('\n')).toMatch(/video[\s\S]*raw html[\s\S]*not run/i);
  });

  it('reports a TeX error and keeps the source visible', async () => {
    const { html, diagnostics } = await doc('Bad $\\frac{1$ math.\n');
    expect(html).toContain('class="math-error"');
    expect(diagnostics[0]?.message).toMatch(/math/i);
  });

  it('survives malformed input', async () => {
    const junk = ['$$', '::: {', '[@', '{{< include', '![](', '{#', '---\n---', ':::\n:::', '$x', '[^1]', '| a |\n|-'];
    for (const s of junk) {
      await expect(doc(s + '\n' + s)).resolves.toHaveProperty('html');
    }
  });

  it('explains when there is nothing to preview', async () => {
    const { html, diagnostics } = await render(memoryProject({ 'README.md': '# hi' }));
    expect(html).toBe('');
    expect(diagnostics[0]?.message).toMatch(/index\.qmd/);
  });
});

describe('frame message limits', () => {
  // protocol.ts refuses a whole message over these limits, so the renderer
  // keeps within them and says what it left out.
  it('caps the number of figures', async () => {
    const files: Record<string, Uint8Array> = {};
    let body = '';
    for (let i = 0; i < 520; i++) {
      files[`f${i}.png`] = new Uint8Array([i % 256]);
      body += `![F${i}.](f${i}.png)\n\n`;
    }
    const { assets, diagnostics } = await doc(body, files);
    expect(assets.length).toBe(500);
    expect(diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/more than 500 figures/i)]);
  });

  it('refuses HTML larger than the frame accepts', async () => {
    const { html, diagnostics } = await doc('&'.repeat(2 * 1024 * 1024));
    expect(html).toBe('');
    expect(diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/too large to preview/i)]);
  });
});

describe('sanitization', () => {
  it('escapes raw HTML, event handlers and inline SVG', async () => {
    const { html } = await doc(
      '<script>alert(1)</script>\n\nInline <img src=x onerror=alert(2)> and <svg><script>alert(3)</script></svg>.\n\n<iframe src="https://evil.example"></iframe>\n',
    );
    expect(html).not.toMatch(/<script|<img src|<svg|<iframe/i);
    expect(html).not.toMatch(/<[^>]+\sonerror=/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops javascript: and data: links', async () => {
    const { html } = await doc('[a](javascript:alert(1)) [b](data:text/html,x) [c](https://example.org) [d](#sec-x)\n');
    expect(html).not.toMatch(/href="(javascript|data):/i);
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain('href="#sec-x"');
  });

  it('never inlines SVG figures', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const { html, assets } = await doc('![Plot.](plot.svg){#fig-p}\n', { 'plot.svg': svg });
    expect(html).not.toContain('<svg');
    expect(assets[0]?.type).toBe('image/svg+xml');
  });

  // The frame's CSP refuses inline style attributes (and reports each one), so
  // styles travel as data-galley-css and are applied through the CSSOM.
  it('emits no style attributes', async () => {
    const { html } = await doc('$\\sqrt{x^2}$ and ![F.](f.png){width=40%}\n\n$$\\frac{a}{b}$$ {#eq-x}\n', { 'f.png': new Uint8Array([1]) });
    expect(html).toContain('data-galley-css="');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('keeps KaTeX links and HTML extensions inactive', async () => {
    const { html } = await doc(
      '$\\href{javascript:alert(1)}{x}$ $\\url{https://evil.example}$ $\\htmlClass{c}{y}$ $\\includegraphics{https://evil.example/a.png}$\n',
    );
    expect(html).not.toMatch(/<a\s|href=|<img/i);
  });

  it('escapes markup coming from the bibliography', async () => {
    const bib =
      '@article{x1, author = {Evil, E.}, year = {2020}, title = {A \\& B <img src=x onerror=alert(1)> <script>bad()</script> <a href="javascript:x">l</a>}, journal = {J}}';
    const { html } = await doc('---\nbibliography: r.bib\n---\n\n@x1\n', { 'r.bib': bib });
    expect(html).not.toMatch(/<img|<script|<a\s|<[^>]*onerror=/i);
    expect(html).toContain('A &#38; B &#60;img');
  });

  it('ignores image sources that leave the repository', async () => {
    const { html, assets, diagnostics } = await doc('![Remote.](https://evil.example/a.png)\n\n![Up.](../../etc/passwd.png)\n');
    expect(assets).toEqual([]);
    expect(html).not.toContain('evil.example');
    expect(diagnostics.length).toBe(2);
  });
});

describe('entry file', () => {
  it('uses the entry chosen in .galley.yml when it exists', async () => {
    const project = { ...memoryProject({ 'index.qmd': 'Index text', 'paper.qmd': 'Paper text' }), entry: 'paper.qmd' };
    expect(text((await render(project)).html)).toContain('Paper text');
  });

  it('ignores a configured entry that is not in the repository', async () => {
    const project = { ...memoryProject({ 'index.qmd': 'Index text' }), entry: 'missing.qmd' };
    expect(text((await render(project)).html)).toContain('Index text');
  });
});
