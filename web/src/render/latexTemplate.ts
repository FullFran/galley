// The LaTeX document shell: preamble, class options and bibliography style.
// The preamble follows what Quarto 1.9 + pandoc 3.9 write for the
// quarto-journals/elsevier format (fixtures/quarto-elsevier-reference.tex), so
// the draft PDF breaks lines and pages like the CI build.

export interface DocumentParts {
  /** `elsarticle` (the elsevier-pdf format) or a plain `article`. */
  elsevier: boolean;
  /** Class options, already ordered. */
  classOptions: string[];
  bibStyle: string;
  journalName?: string;
  /** Escaped plain text for the PDF metadata. */
  pdfTitle: string;
  pdfAuthor: string;
  pdfKeywords: string;
  /** Everything between `\begin{document}` and the body. */
  frontmatter: string;
  body: string;
  /** `\bibliography{...}` when it was not placed by a refs div. */
  trailer: string;
}

const PREAMBLE_A = String.raw`\usepackage{xcolor}
\usepackage{amsmath,amssymb}
\setcounter{secnumdepth}{5}
\usepackage{iftex}
\ifPDFTeX
  \usepackage[T1]{fontenc}
  \usepackage[utf8]{inputenc}
  \usepackage{textcomp} % provide euro and other symbols
\else % if luatex or xetex
  \usepackage{unicode-math} % this also loads fontspec
  \defaultfontfeatures{Scale=MatchLowercase}
  \defaultfontfeatures[\rmfamily]{Ligatures=TeX,Scale=1}
\fi
\usepackage{lmodern}
\ifPDFTeX\else
  % xetex/luatex font selection
\fi
% Use upquote if available, for straight quotes in verbatim environments
\IfFileExists{upquote.sty}{\usepackage{upquote}}{}
\IfFileExists{microtype.sty}{% use microtype if available
  \usepackage[]{microtype}
  \UseMicrotypeSet[protrusion]{basicmath} % disable protrusion for tt fonts
}{}
\makeatletter
\@ifundefined{KOMAClassName}{% if non-KOMA class
  \IfFileExists{parskip.sty}{%
    \usepackage{parskip}
  }{% else
    \setlength{\parindent}{0pt}
    \setlength{\parskip}{6pt plus 2pt minus 1pt}}
}{% if KOMA class
  \KOMAoptions{parskip=half}}
\makeatother
% Make \paragraph and \subparagraph free-standing
\makeatletter
\ifx\paragraph\undefined\else
  \let\oldparagraph\paragraph
  \renewcommand{\paragraph}{
    \@ifstar
      \xxxParagraphStar
      \xxxParagraphNoStar
  }
  \newcommand{\xxxParagraphStar}[1]{\oldparagraph*{#1}\mbox{}}
  \newcommand{\xxxParagraphNoStar}[1]{\oldparagraph{#1}\mbox{}}
\fi
\ifx\subparagraph\undefined\else
  \let\oldsubparagraph\subparagraph
  \renewcommand{\subparagraph}{
    \@ifstar
      \xxxSubParagraphStar
      \xxxSubParagraphNoStar
  }
  \newcommand{\xxxSubParagraphStar}[1]{\oldsubparagraph*{#1}\mbox{}}
  \newcommand{\xxxSubParagraphNoStar}[1]{\oldsubparagraph{#1}\mbox{}}
\fi
\makeatother


\usepackage{longtable,booktabs,array}
\newcounter{none} % for unnumbered tables
\usepackage{calc} % for calculating minipage widths
% Correct order of tables after \paragraph or \subparagraph
\usepackage{etoolbox}
\makeatletter
\patchcmd\longtable{\par}{\if@noskipsec\mbox{}\fi\par}{}{}
\makeatother
% Allow footnotes in longtable head/foot
\IfFileExists{footnotehyper.sty}{\usepackage{footnotehyper}}{\usepackage{footnote}}
\makesavenoteenv{longtable}
\usepackage{graphicx}
\makeatletter
\newsavebox\pandoc@box
\newcommand*\pandocbounded[1]{% scales image to fit in text height/width
  \sbox\pandoc@box{#1}%
  \Gscale@div\@tempa{\textheight}{\dimexpr\ht\pandoc@box+\dp\pandoc@box\relax}%
  \Gscale@div\@tempb{\linewidth}{\wd\pandoc@box}%
  \ifdim\@tempb\p@<\@tempa\p@\let\@tempa\@tempb\fi% select the smaller of both
  \ifdim\@tempa\p@<\p@\scalebox{\@tempa}{\usebox\pandoc@box}%
  \else\usebox{\pandoc@box}%
  \fi%
}
% Set default figure placement to htbp
\def\fps@figure{htbp}
\makeatother





\setlength{\emergencystretch}{3em} % prevent overfull lines

\providecommand{\tightlist}{%
  \setlength{\itemsep}{0pt}\setlength{\parskip}{0pt}}`;

const PREAMBLE_B = String.raw`\makeatletter
\@ifpackageloaded{caption}{}{\usepackage{caption}}
\AtBeginDocument{%
\ifdefined\contentsname
  \renewcommand*\contentsname{Table of contents}
\else
  \newcommand\contentsname{Table of contents}
\fi
\ifdefined\listfigurename
  \renewcommand*\listfigurename{List of Figures}
\else
  \newcommand\listfigurename{List of Figures}
\fi
\ifdefined\listtablename
  \renewcommand*\listtablename{List of Tables}
\else
  \newcommand\listtablename{List of Tables}
\fi
\ifdefined\figurename
  \renewcommand*\figurename{Figure}
\else
  \newcommand\figurename{Figure}
\fi
\ifdefined\tablename
  \renewcommand*\tablename{Table}
\else
  \newcommand\tablename{Table}
\fi
}
\@ifpackageloaded{float}{}{\usepackage{float}}
\floatstyle{ruled}
\@ifundefined{c@chapter}{\newfloat{codelisting}{h}{lop}}{\newfloat{codelisting}{h}{lop}[chapter]}
\floatname{codelisting}{Listing}
\newcommand*\listoflistings{\listof{codelisting}{List of Listings}}
\makeatother
\makeatletter
\makeatother
\makeatletter
\@ifpackageloaded{caption}{}{\usepackage{caption}}
\@ifpackageloaded{subcaption}{}{\usepackage{subcaption}}
\makeatother
\usepackage{bookmark}
\IfFileExists{xurl.sty}{\usepackage{xurl}}{} % add URL line breaks if available
\urlstyle{same}`;

export function assembleDocument(p: DocumentParts): string {
  const documentclass = p.elsevier
    ? `\\documentclass[\n  ${p.classOptions.join(',\n  ')}]{elsarticle}`
    : `\\documentclass[${p.classOptions.join(',')}]{article}`;
  const hypersetup = [
    p.pdfTitle && `  pdftitle={${p.pdfTitle}},`,
    p.pdfAuthor && `  pdfauthor={${p.pdfAuthor}},`,
    p.pdfKeywords && `  pdfkeywords={${p.pdfKeywords}},`,
  ].filter(Boolean);
  return [
    '% Generated by galley for the draft PDF preview.',
    String.raw`\PassOptionsToPackage{unicode}{hyperref}`,
    String.raw`\PassOptionsToPackage{hyphens}{url}`,
    String.raw`\PassOptionsToPackage{dvipsnames,svgnames,x11names}{xcolor}`,
    '%',
    documentclass,
    PREAMBLE_A,
    '',
    String.raw`\usepackage[]{natbib}`,
    `\\bibliographystyle{${p.bibStyle}}`,
    '',
    PREAMBLE_B,
    String.raw`\hypersetup{`,
    ...hypersetup,
    String.raw`  colorlinks=true,
  linkcolor={blue},
  filecolor={Maroon},
  citecolor={Blue},
  urlcolor={Blue},
  pdfcreator={LaTeX via galley}}`,
    p.journalName ? `\\journal{${p.journalName}}` : '',
    p.elsevier ? String.raw`\setlength{\parindent}{6pt}` : '',
    String.raw`\begin{document}`,
    '',
    p.frontmatter,
    p.body,
    p.trailer,
    String.raw`\end{document}`,
    '',
  ].join('\n');
}
