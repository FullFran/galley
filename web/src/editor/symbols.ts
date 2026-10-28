// The LaTeX symbol palette: a fixed catalog of math commands, a search over
// it, the math-context check that decides whether an insertion needs `$…$`,
// and the list of recently used symbols. All plain data and pure functions;
// the palette UI (and KaTeX, for the previews) loads on demand.

export type SymbolGroupId = 'greek' | 'operators' | 'relations' | 'arrows' | 'accents' | 'delimiters' | 'constructs';

export interface MathSymbol {
  /** Stable key, the command as written (`\alpha`, `\frac{}{}`). */
  id: string;
  /** Text inserted; empty braces are where the caret (or the selection) goes. */
  insert: string;
  /** KaTeX source of the preview. */
  preview: string;
  /** English search words. */
  name: string;
}

export interface SymbolGroup {
  id: SymbolGroupId;
  symbols: MathSymbol[];
}

const simple = (name: string, cmds: string): MathSymbol[] =>
  cmds
    .split(' ')
    .filter(Boolean)
    .map((c) => ({ id: c, insert: c, preview: c, name: `${name} ${c.slice(1)}` }));

const construct = (insert: string, preview: string, name: string): MathSymbol => ({ id: insert, insert, preview, name });

const GREEK =
  '\\alpha \\beta \\gamma \\delta \\epsilon \\varepsilon \\zeta \\eta \\theta \\vartheta \\iota \\kappa \\lambda \\mu \\nu \\xi \\pi \\varpi \\rho \\varrho \\sigma \\varsigma \\tau \\upsilon \\phi \\varphi \\chi \\psi \\omega \\Gamma \\Delta \\Theta \\Lambda \\Xi \\Pi \\Sigma \\Upsilon \\Phi \\Psi \\Omega';

export const SYMBOL_GROUPS: readonly SymbolGroup[] = [
  { id: 'greek', symbols: simple('greek letter', GREEK) },
  {
    id: 'operators',
    symbols: [
      ...simple('operator', '\\pm \\mp \\times \\div \\cdot \\ast \\star \\circ \\bullet \\oplus \\otimes \\cap \\cup \\setminus \\wedge \\vee \\nabla \\partial \\infty \\hbar \\ell \\forall \\exists \\neg \\emptyset'),
      ...simple('big operator', '\\prod \\coprod \\bigcup \\bigcap \\oint \\iint'),
      ...simple('function', '\\sin \\cos \\tan \\log \\ln \\exp \\lim \\max \\min'),
    ],
  },
  {
    id: 'relations',
    symbols: simple(
      'relation',
      '\\leq \\geq \\neq \\approx \\equiv \\sim \\simeq \\cong \\propto \\ll \\gg \\subset \\supset \\subseteq \\supseteq \\in \\notin \\ni \\perp \\parallel \\mid',
    ),
  },
  {
    id: 'arrows',
    symbols: simple(
      'arrow',
      '\\to \\gets \\leftarrow \\rightarrow \\leftrightarrow \\Leftarrow \\Rightarrow \\Leftrightarrow \\mapsto \\uparrow \\downarrow \\longrightarrow \\implies \\iff \\rightleftharpoons',
    ),
  },
  {
    id: 'accents',
    symbols: [
      construct('\\hat{}', '\\hat{x}', 'accent hat'),
      construct('\\bar{}', '\\bar{x}', 'accent bar mean'),
      construct('\\tilde{}', '\\tilde{x}', 'accent tilde'),
      construct('\\vec{}', '\\vec{x}', 'accent vector arrow'),
      construct('\\dot{}', '\\dot{x}', 'accent dot derivative'),
      construct('\\ddot{}', '\\ddot{x}', 'accent double dot second derivative'),
      construct('\\overline{}', '\\overline{xy}', 'accent overline'),
      construct('\\underline{}', '\\underline{xy}', 'accent underline'),
      construct('\\mathbf{}', '\\mathbf{x}', 'bold font'),
      construct('\\mathrm{}', '\\mathrm{d}', 'roman upright font'),
      construct('\\mathcal{}', '\\mathcal{L}', 'calligraphic font'),
      construct('\\mathbb{}', '\\mathbb{R}', 'blackboard bold font real numbers'),
    ],
  },
  {
    id: 'delimiters',
    symbols: [
      construct('\\left( \\right)', '\\left( x \\right)', 'delimiter parentheses brackets left right'),
      construct('\\left[ \\right]', '\\left[ x \\right]', 'delimiter square brackets'),
      construct('\\left\\{ \\right\\}', '\\left\\{ x \\right\\}', 'delimiter curly braces'),
      construct('\\left| \\right|', '\\left| x \\right|', 'delimiter absolute value bars'),
      construct('\\langle \\rangle', '\\langle x \\rangle', 'delimiter angle brackets expectation'),
      construct('\\lfloor \\rfloor', '\\lfloor x \\rfloor', 'delimiter floor'),
      construct('\\lceil \\rceil', '\\lceil x \\rceil', 'delimiter ceiling'),
      construct('\\|', '\\|x\\|', 'delimiter norm double bar'),
    ],
  },
  {
    id: 'constructs',
    symbols: [
      construct('\\frac{}{}', '\\frac{a}{b}', 'fraction divide'),
      construct('\\sqrt{}', '\\sqrt{x}', 'square root'),
      construct('\\sqrt[]{}', '\\sqrt[n]{x}', 'nth root'),
      construct('^{}', 'x^{2}', 'superscript power exponent'),
      construct('_{}', 'x_{i}', 'subscript index'),
      construct('\\sum_{}^{}', '\\sum_{i=1}^{n}', 'sum summation sigma'),
      construct('\\prod_{}^{}', '\\prod_{i=1}^{n}', 'product'),
      construct('\\int_{}^{}', '\\int_{a}^{b}', 'integral definite'),
      construct('\\int', '\\int', 'integral'),
      construct('\\lim_{}', '\\lim_{x \\to 0}', 'limit'),
      construct('\\binom{}{}', '\\binom{n}{k}', 'binomial choose'),
      construct('\\begin{pmatrix}  &  \\\\  &  \\end{pmatrix}', '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', 'matrix parentheses pmatrix'),
      construct('\\begin{bmatrix}  &  \\\\  &  \\end{bmatrix}', '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}', 'matrix brackets bmatrix'),
      construct('\\begin{cases}  & \\text{if }  \\\\  & \\text{otherwise} \\end{cases}', 'f = \\begin{cases} a & x > 0 \\\\ b & \\text{else} \\end{cases}', 'cases piecewise'),
      construct('\\text{}', '\\text{text}', 'text words'),
    ],
  },
];

const BY_ID = new Map(SYMBOL_GROUPS.flatMap((g) => g.symbols.map((s) => [s.id, s] as const)));

export const symbolById = (id: string): MathSymbol | undefined => BY_ID.get(id);

const fold = (s: string) => s.toLowerCase().replace(/\\/g, '').trim();

/** Groups with the symbols that match `query` (command or name); commands starting with it come first. */
export function searchSymbols(query: string): SymbolGroup[] {
  const q = fold(query);
  if (!q) return SYMBOL_GROUPS.map((g) => ({ id: g.id, symbols: [...g.symbols] }));
  const rank = (s: MathSymbol) => (fold(s.id).startsWith(q) ? 0 : fold(s.id).includes(q) ? 1 : 2);
  const out: SymbolGroup[] = [];
  for (const g of SYMBOL_GROUPS) {
    const hits = g.symbols.filter((s) => fold(s.id).includes(q) || fold(s.name).includes(q));
    // A stable sort keeps catalog order within a rank.
    if (hits.length) out.push({ id: g.id, symbols: hits.sort((a, b) => rank(a) - rank(b)) });
  }
  return out.sort((a, b) => Math.min(...a.symbols.map(rank)) - Math.min(...b.symbols.map(rank)));
}

/**
 * Whether `pos` is inside math: `$…$`, `$$…$$`, `\(…\)` or `\[…\]`. Escaped
 * dollars, code spans and fenced code blocks do not count.
 */
export function inMath(text: string, pos: number): boolean {
  let math: '' | '$' | '$$' | '\\(' | '\\[' = '';
  let i = 0;
  const end = Math.min(pos, text.length);
  while (i < end) {
    const lineStart = i === 0 || text[i - 1] === '\n';
    if (!math && lineStart && /^ {0,3}(```|~~~)/.test(text.slice(i, i + 6))) {
      const fence = text.slice(i).match(/^ {0,3}(`{3,}|~{3,})/)?.[1] ?? '```';
      const close = text.indexOf(`\n${fence}`, i + fence.length);
      if (close === -1 || close >= end) return false;
      i = close + 1 + fence.length;
      continue;
    }
    const c = text[i];
    if (c === '\\') {
      const next = text[i + 1];
      if (!math && (next === '(' || next === '[')) math = next === '(' ? '\\(' : '\\[';
      else if ((math === '\\(' && next === ')') || (math === '\\[' && next === ']')) math = '';
      i += 2;
      continue;
    }
    if (c === '`' && !math) {
      const run = text.slice(i).match(/^`+/)?.[0] ?? '`';
      const close = text.indexOf(run, i + run.length);
      if (close === -1 || close >= end) return false;
      i = close + run.length;
      continue;
    }
    if (c === '$') {
      const dbl = text[i + 1] === '$';
      if (!math) {
        math = dbl ? '$$' : '$';
        i += dbl ? 2 : 1;
      } else if (math === '$$' && dbl) {
        math = '';
        i += 2;
      } else {
        if (math === '$') math = '';
        i++;
      }
      continue;
    }
    i++;
  }
  return math !== '';
}

export interface SymbolInsert {
  from: number;
  to: number;
  insert: string;
  /** Absolute caret position after the change. */
  caret: number;
}

/**
 * The change that inserts `snippet` over `from`..`to`. Outside math it is
 * wrapped in `$…$`. A selection goes into the first empty braces; otherwise
 * the caret lands there, or after the symbol.
 */
export function planSymbolInsert(doc: string, from: number, to: number, snippet: string): SymbolInsert {
  const wrap = !inMath(doc, from);
  const selected = doc.slice(from, to);
  const braces = snippet.indexOf('{}');
  let body = snippet;
  let caretIn: number;
  if (braces !== -1) {
    body = `${snippet.slice(0, braces + 1)}${selected}${snippet.slice(braces + 1)}`;
    caretIn = selected ? body.length : braces + 1;
  } else {
    caretIn = snippet.length;
  }
  const lead = wrap ? 1 : 0;
  return { from, to, insert: wrap ? `$${body}$` : body, caret: from + lead + caretIn };
}

export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const RECENT_KEY = 'galley.symbols.recent';
export const RECENT_LIMIT = 16;

/** Recently inserted symbol ids, most recent first; unknown ids are dropped. */
export function readRecent(store: KeyStore | undefined): string[] {
  try {
    const raw = store?.getItem(RECENT_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((id): id is string => typeof id === 'string' && BY_ID.has(id)).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

export function pushRecent(store: KeyStore | undefined, id: string): string[] {
  const next = [id, ...readRecent(store).filter((r) => r !== id)].slice(0, RECENT_LIMIT);
  try {
    store?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked (private window): recents last for this page only.
  }
  return next;
}
