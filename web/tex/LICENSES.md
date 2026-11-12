# Licenses of the in-browser TeX engine

galley compiles the draft PDF in the browser with BusyTeX, a WebAssembly build of TeX Live. The
files served under `/tex/` are assembled by `web/scripts/build-tex.mjs` from the pinned upstream
release listed in `web/tex/assets.json` (SHA-256 verified) and the files in `web/tex/`.

## BusyTeX scripts (MIT)

- `busytex_pipeline.js`, `busytex_worker.js`: vendored from <https://github.com/busytex/busytex>
  (release `build_wasm_4499aa69fd3cf77ad86a47287d9a5193cf5ad993_7936974349_1`). The upstream README
  states: "MIT - applies only to the code and scripts in the repo, not to the published binaries
  (on the releases page). The binaries include linked TexLive code, so the respective TexLived /
  dependencies licenses apply." The upstream repository has no separate LICENSE file.
  galley changes two lines of the pipeline, each marked with a `// galley:` comment.
- The Emscripten loader `galley-tex.js` is generated from the upstream `texlive-basic.js` loader
  (Emscripten file_packager output, MIT/University of Illinois-NCSA licensed runtime code).
- Not used: `texlyre-busytex` (AGPL-3.0).

## Binaries (`busytex.wasm`, `busytex.js`)

TeX Live 2023 programs (pdfTeX, BibTeX8, kpathsea and their libraries: expat, fontconfig, zlib,
libpng, ...) compiled with Emscripten 3.1.43. They stay under their own free software licenses,
see <https://tug.org/texlive/LICENSE.TL> (also shipped in the data package as `/texlive/LICENSE.TL`
and `/texlive/LICENSE.CTAN`), and the upstream release notes at
<https://github.com/busytex/busytex/releases>.

## TeX Live and Ubuntu package content (`galley-tex.data`)

The data package is a subset of the TeX Live 2023 trees shipped in the upstream release (the
`texlive-basic` and `ubuntu-texlive-*` packages): LaTeX kernel, `amsmath`, `hyperref`, `natbib`,
`siunitx`, `microtype`, `xcolor`, `geometry`, `caption`, `lineno`, ... and the Latin Modern, AMS and
Times fonts. Each file keeps the license of its package, mostly the LaTeX Project Public License
(<https://www.latex-project.org/lppl/>), the GUST Font License (Latin Modern), the SIL OFL / AMS
font licenses, and the URW base 35 license. The per-package licenses are listed in
<https://tug.org/texlive/LICENSE.TL> and on CTAN (<https://ctan.org/pkg/PACKAGE>).

## elsarticle (LPPL 1.3c)

`elsarticle.cls`, `elsarticle-num.bst`, `elsarticle-harv.bst`, `elsarticle-num-names.bst` are copied
from the Quarto `elsevier` journal format (<https://github.com/quarto-journals/elsevier>, MIT) and
are the Elsevier `elsarticle` bundle, Copyright Elsevier Ltd, distributed under the LaTeX Project
Public License 1.3c (<https://ctan.org/pkg/elsarticle>). They are unmodified and placed under
`tex/latex/elsarticle/` and `bibtex/bst/elsarticle/` of the data package.
