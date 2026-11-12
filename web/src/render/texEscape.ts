// Text escaping for the LaTeX backend. The generated documents use pdfLaTeX
// with `inputenc` utf8 and T1 fonts, which typeset Latin-1/Latin Extended-A
// text and a handful of punctuation marks directly. Other symbols are mapped
// to commands where there is a safe one and reported otherwise.

const SPECIALS: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  '%': '\\%',
  _: '\\_',
  '^': '\\textasciicircum{}',
  '~': '\\textasciitilde{}',
  '<': '\\textless{}',
  '>': '\\textgreater{}',
  '|': '\\textbar{}',
  '\u00a0': '~',
  '\u2009': '\\,',
  '\u202f': '\\,',
  '\u2002': ' ',
  '\u2003': ' ',
  '\u2212': '\\ensuremath{-}',
  '\u2032': "\\ensuremath{'}",
  '\u2192': '\\ensuremath{\\rightarrow}',
  '\u2190': '\\ensuremath{\\leftarrow}',
  '\u2194': '\\ensuremath{\\leftrightarrow}',
  '\u21d2': '\\ensuremath{\\Rightarrow}',
  '\u2264': '\\ensuremath{\\leq}',
  '\u2265': '\\ensuremath{\\geq}',
  '\u2260': '\\ensuremath{\\neq}',
  '\u2248': '\\ensuremath{\\approx}',
  '\u221e': '\\ensuremath{\\infty}',
  '\u00b1': '\\ensuremath{\\pm}',
  '\u2211': '\\ensuremath{\\sum}',
  '\u221a': '\\ensuremath{\\surd}',
  '\u2202': '\\ensuremath{\\partial}',
  '\u2206': '\\ensuremath{\\Delta}',
  '\u2207': '\\ensuremath{\\nabla}',
  '\u2208': '\\ensuremath{\\in}',
  '\u22c5': '\\ensuremath{\\cdot}',
  '\u2217': '\\ensuremath{\\ast}',
};

const GREEK_LOWER = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'o', 'pi', 'rho', 'varsigma', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega'];
GREEK_LOWER.forEach((name, i) => {
  if (name !== 'o') SPECIALS[String.fromCharCode(0x3b1 + i)] = `\\ensuremath{\\${name}}`;
});
const GREEK_UPPER: Record<string, string> = { '\u0393': 'Gamma', '\u0394': 'Delta', '\u0398': 'Theta', '\u039b': 'Lambda', '\u039e': 'Xi', '\u03a0': 'Pi', '\u03a3': 'Sigma', '\u03a6': 'Phi', '\u03a8': 'Psi', '\u03a9': 'Omega' };
for (const [ch, name] of Object.entries(GREEK_UPPER)) SPECIALS[ch] = `\\ensuremath{\\${name}}`;
SPECIALS['\u00b5'] = '\\ensuremath{\\mu}'; // micro sign

/** Code points that inputenc/T1 typeset as they are. */
const PLAIN = /^[\u00a1-\u00ff\u0100-\u017f\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2020\u2021\u2022\u2026\u2030\u20ac]$/u;
/** Control characters and zero-width marks, which are dropped. */
function isInvisible(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) || code === 0x2060 || code === 0xfeff;
}

/**
 * Escapes plain text for a LaTeX argument or paragraph. Characters that
 * pdfLaTeX cannot typeset become "?" and their code points are added to
 * `unsupported` so the caller can report them once.
 */
export function texEscape(text: string, unsupported?: Set<string>): string {
  let out = '';
  for (const ch of text) {
    const special = SPECIALS[ch];
    if (special !== undefined) out += special;
    else if (ch === '\n' || ch === '\t' || (ch >= ' ' && ch <= '~')) out += ch;
    else if (PLAIN.test(ch)) out += ch;
    else if (isInvisible(ch.codePointAt(0) ?? 0)) continue;
    else {
      unsupported?.add(`U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`);
      out += '?';
    }
  }
  return out;
}

/** Escapes a URL for `\href`: only `%` and `#` are special there. */
export const texUrl = (url: string) => url.replace(/[%#]/g, '\\$&').replace(/\\(?![%#])/g, '/');
