// The fictional repository behind demo mode: a deliberately silly paper that
// still uses what galley shows off (headings, an equation, a table, citations).

export const GALLEY_YML = `version: 1
title: The optimal toasting time of bread
entry: index.qmd
editable:
  - index.qmd
  - references.bib
labels:
  index.qmd: Paper
  references.bib: References
preview:
  auto_compile: true
`;

export const QUARTO_YML = `project:
  type: default
  render:
    - index.qmd

bibliography: references.bib

crossref:
  eq-prefix: Eq.
  tbl-prefix: Table
  sec-prefix: Section

format:
  html:
    number-sections: true
`;

export const REFERENCES_BIB = `@article{crumb2019,
  author  = {Crumb, Ada and Loaf, Ben},
  year    = {2019},
  title   = {A survey of breakfast heat transfer},
  journal = {Journal of Kitchen Physics},
  volume  = {12},
  pages   = {1--3}
}

@book{butter2021,
  author    = {Butter, Margaret},
  year      = {2021},
  title     = {Spreads: a history},
  publisher = {Pantry Press}
}
`;

export const INDEX_QMD = `---
title: "The optimal toasting time of bread"
author:
  - name: Ada Crumb
  - name: You
abstract: |
  We put bread in a toaster and waited. Two minutes is best.
---

# Introduction {#sec-intro}

Toast is bread that has been warmed until it turns golden. Earlier work
measured how heat reaches a slice [@crumb2019], but nobody asked when to
stop. This paper waits by the toaster so you do not have to.

# Model {#sec-model}

We call how golden a slice is $g$, from 0 (bread) to 1 (perfect toast).
It grows with time $t$ as

$$g(t) = 1 - e^{-t/\\tau}$$ {#eq-golden}

where $\\tau$ is how patient the toaster is.

## Burning {#sec-burning}

After about three minutes @eq-golden stops being useful: the toast burns.

# Results {#sec-results}

| Time (s) | Golden |
|---|---|
| 60 | 0.4 |
| 120 | 0.9 |
| 180 | burnt |

: How golden the toast was. {#tbl-golden}

# Conclusion {#sec-conclusion}

Two minutes, as @tbl-golden shows. Butter is outside the scope of
@sec-model [@butter2021].
`;

/** Ada's open proposal: one paragraph about butter. */
export const BUTTER_PARAGRAPH = `
## Butter {#sec-butter}

Butter melts faster on warm toast, so spread it straight away.
`;

export const DEMO_FILES: Record<string, string> = {
  '.galley.yml': GALLEY_YML,
  '_quarto.yml': QUARTO_YML,
  'index.qmd': INDEX_QMD,
  'references.bib': REFERENCES_BIB,
};
