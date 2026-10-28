# `.galley.yml`: project configuration

`.galley.yml` sits at the root of the paper repository. It tells galley which
files co-authors edit, where figures can be uploaded, what to call each file
and how the preview behaves. It is versioned with the paper, so GitHub stays
the source of truth.

## Who can change it

- In galley, only repository **admins** (GitHub `permissions.admin`) see the
  "Project settings" screen and the `.galley.yml` file itself.
- On GitHub, anyone with write access can still edit the file. galley
  therefore treats it as untrusted input (see [Safety](#safety)).
- The file list is a **galley view**, not a permission. Co-authors keep
  whatever access GitHub gives them; galley only decides what it lists.

## Example

```yaml
version: 1
title: TL glow curve paper
entry: index.qmd
editable:
  - index.qmd
  - sections/*.qmd
  - references.bib
uploads:
  - folder: figures/
    accept: [png, jpg, jpeg, svg, pdf]
    max_size_mb: 10
labels:
  sections/01-introduction.qmd: Introduction
preview:
  auto_compile: false
editor:
  default_mode: writing
```

## Fields

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `version` | yes | `1` | | Schema version. Only `1` exists. |
| `title` | no | text, at most 120 characters | | Display name of the paper. |
| `entry` | no | one `.qmd` or `.md` path | `_quarto.yml` `project.render`, else `index.qmd` | Main document of the preview. |
| `editable` | yes | list of paths or patterns, at most 200 | | Files co-authors see and edit. |
| `uploads` | no | list of folders, at most 20 | none | Folders that accept uploaded files. |
| `uploads[].folder` | yes | folder path | | A trailing `/` is added if missing. |
| `uploads[].accept` | no | list of extensions, at most 20 | `png, jpg, jpeg, svg, pdf` | Lower-cased, without the dot. |
| `uploads[].max_size_mb` | no | number, above 0 and at most 25 | `10` | Largest accepted file. |
| `labels` | no | map of path to text, at most 500 | none | Friendly names shown for files. |
| `preview.auto_compile` | no | `true` or `false` | `false` | Default for people who have not chosen; each person can toggle it. |
| `editor.default_mode` | no | `writing` or `code` | Writing for co-authors, Code for admins | Editor mode for people who have not chosen one. |

`uploads` and `labels` are read and validated now; figure upload and friendly
names in the file list arrive with the writing-feel work (CX2).

## Patterns

Paths are relative to the repository root and use `/` between folders.

| Pattern | Matches |
| --- | --- |
| `*` | any characters inside one folder name: `sections/*.qmd` matches `sections/a.qmd`, not `sections/x/a.qmd` |
| `**` | as a whole folder name, zero or more folders: `sections/**/*.qmd` matches both; a trailing `sections/**` matches everything inside `sections/` |
| `?` | exactly one character inside a name |

- Wildcards never match a name that starts with a dot, so `**` never reaches
  `.galley.yml` or `.github/`. A dotted name must be written out.
- Not supported (rejected with an error): a leading `/` or `~`, drive letters,
  `..` or `.` segments, empty segments (`a//b`), a trailing `/`, backslashes,
  `[...]`, `{...}`, `!`, `**` inside a name, control characters, patterns over
  200 characters.
- `entry`, `labels` keys and upload folders must be plain paths (no
  wildcards). Upload folders must not be hidden (no segment starting with `.`).

## Validation

- **Errors** (wrong types, invalid paths, caps exceeded, unsupported version,
  invalid YAML) make the whole file invalid. galley then falls back to safe
  defaults: co-authors see the paper's text files (`.qmd`, `.md`, `.bib`, no
  hidden folders), and admins see the errors on the workspace and settings
  screens.
- **Warnings** (unknown keys) are shown to admins; the rest of the file still
  applies.
- The file may be at most 64 KB.

## What co-authors see

| Situation | Admins | Co-authors |
| --- | --- | --- |
| No `.galley.yml` | all files and a "Set up galley for this paper" wizard | `.qmd`, `.md`, `.bib` files and a note to ask an admin |
| Valid file | all files and "Project settings" | files matching `editable` |
| Invalid file | all files and the errors | `.qmd`, `.md`, `.bib` files and a note to ask an admin |

`.galley.yml` and `.github/` are never listed for co-authors, even if a
pattern names them. The preview always renders from the whole repository.

## Setup wizard and settings

When the file is missing, admins get a wizard prefilled from the repository:
the entry from `_quarto.yml`, the files reachable from it through
`{{< include >}}` (a folder whose `.qmd` files are all included becomes
`folder/*.qmd`), the bibliography, a `figures/` upload folder when one exists,
and each included file's first heading as its label.

Saving the wizard or the settings screen is an ordinary galley save: one
commit with `.galley.yml` on your working branch (`galley/<login>`) and its
pull request. The new settings apply to you at once and to everyone once the
pull request is merged. The form checks the file exactly as galley will read
it and refuses to save one with errors. Output has a fixed key order and no
comments.

## Preview compile

The preview has a **Recompile** button (Ctrl+Enter, or Cmd+Enter on macOS)
and an **Auto-compile** toggle. With auto-compile off, edits are not rendered
until you recompile; with it on, edits render after a short pause. The default
comes from `preview.auto_compile`; your own choice is remembered per
repository in this browser.

## Editor mode

The editor has two modes, switched with **Writing | Code** in the header (in
the ⋯ menu on phones) or in Preferences → Editor:

- **Writing**: soft wrap, a comfortable paper font, lines of about 72
  characters, no line numbers and only quiet hints for headings, math and
  citations.
- **Code**: monospace, line numbers and full syntax colours.

Each person's choice is remembered in this browser. Until someone chooses,
`editor.default_mode` decides; without it co-authors get Writing and admins
get Code. The settings screen has the same choice under "Editor".

## Safety

- Parsed with js-yaml's core schema: no custom tags, aliases refused, depth
  limited, duplicate keys rejected.
- Every path is checked so it cannot point outside the repository; galley
  never reads or writes files through `.galley.yml` beyond what the signed-in
  user's GitHub token allows.
- All strings from the file are rendered as text, never as HTML.
- The matcher builds no regular expressions from the file and runs in
  polynomial time.
