// English UI copy, grouped by screen. Plain, informal second person, no
// jargon, no exclamation marks. Values that need numbers or names are small
// functions, so another language can change word order and plurals.

export const en = {
  app: {
    name: 'galley',
    loading: 'Loading…',
    sessionEnded: 'Your session has ended. Please sign in again.',
    leavePrompt: 'You have unsaved changes. Leave anyway?',
  },
  nav: {
    repos: 'Repositories',
    paper: 'Paper',
    files: 'Files',
    proposals: 'Proposals',
    settings: 'Project settings',
    tour: 'Take the tour',
    about: 'About galley',
    proposalsCount: (n: number) => `Proposals, ${n} open`,
    mine: (n: number) => `Yours: #${n}`,
    tourSoon: 'The guided tour arrives in the next version of galley.',
  },
  shell: {
    skip: 'Skip to content',
    sidebar: 'Sidebar',
    mainNav: 'Main',
    breadcrumb: 'Breadcrumb',
    collapse: 'Collapse the sidebar',
    expand: 'Expand the sidebar',
    openMenu: 'Open the menu',
    closeMenu: 'Close the menu',
    shortcut: 'Ctrl+B',
    signedInAs: (login: string) => `Signed in as ${login}`,
    signOut: 'Sign out',
    dismiss: 'Dismiss',
    notifications: 'Notifications',
  },
  credit: {
    builtBy: 'Built by',
    author: 'Francisco Olmedo',
    source: 'Source on GitHub',
  },
  about: {
    title: 'About galley',
    summary: 'galley lets a small team write a Quarto paper in the browser and review every change on GitHub.',
    version: (v: string) => `Version ${v}`,
    licence: 'Licence: MIT',
    creditsTitle: 'Credits',
    credits: [
      'Elsevier Harvard citation style and en-US locale, from the Citation Style Language project (CC BY-SA 3.0).',
      'CMU Serif (Computer Modern Unicode) by Andrey V. Panov and the authors of the Metafont fonts (SIL Open Font License 1.1).',
      'citeproc-js by Frank Bennett (CPAL 1.0, dual-licensed with AGPL).',
      'KaTeX, markdown-it, markdown-it-footnote, js-yaml, CodeMirror and Preact (MIT); DOMPurify (MPL-2.0 or Apache-2.0).',
    ],
    close: 'Close',
  },
  landing: {
    title: 'Write your paper in the browser.',
    lead: 'galley turns every save into a reviewable proposal on GitHub.',
    signIn: 'Sign in with GitHub',
    access:
      'You sign in with your GitHub account. galley only sees the papers where its GitHub App is installed, and it changes files only when you choose Save for review.',
    loginFailed: 'Sign in did not complete. Please try again.',
    unsaved: 'These changes were not saved. Copy them before signing in again, because signing in reloads the page.',
    https: 'Open galley over https:',
    mockSave: 'Save for review',
  },
  repos: {
    title: 'Choose a repository',
    intro: 'Pick the paper you want to work on.',
    search: 'Search repositories',
    searchPlaceholder: 'Filter by name',
    private: 'Private',
    public: 'Public',
    updated: (date: string) => `Updated ${date}`,
    emptyTitle: 'No repositories yet',
    emptyBody:
      'galley can only open repositories where the galley GitHub App is installed. Ask the owner of the repository to install it and give you access, then reload this page.',
    reload: 'Reload',
    noMatch: (q: string) => `No repositories match "${q}".`,
    clearSearch: 'Clear search',
    tryAgain: 'Try again',
  },
  workspace: {
    opening: (repo: string) => `Opening ${repo}`,
    tryAgain: 'Try again',
    truncated: 'Some files are not listed because the repository is very large.',
    chooseFile: 'Choose a file to edit.',
    loadingSettings: 'Loading project settings',
    show: 'Show',
    edit: 'Edit',
    preview: 'Preview',
    previewRegion: 'Preview',
    editorRegion: 'Editor',
  },
  save: {
    allSaved: 'All changes saved',
    unsaved: (n: number) => `${n} unsaved file${n === 1 ? '' : 's'}`,
    saving: 'Saving…',
    button: 'Save for review',
    addNote: 'Add a note',
    noteLabel: 'Short description of your changes',
    noteHint: 'Optional. Your co-authors see it with the proposal.',
    describe: 'Describe your changes',
  },
  outline: {
    mainFile: 'Main file',
    outlineOf: (file: string) => `Outline of ${file}`,
    noHeadings: 'No headings in this file yet. Start a line with # to add one.',
    openFile: (file: string) => `Open ${file}`,
  },
  files: {
    edited: '(edited)',
    viewLabel: 'Files to show',
    viewAll: 'Show all files',
    viewCoauthor: 'View as co-author',
    modeAll: 'You see every file because you are an admin.',
    modeCoauthor: 'You see only what co-authors see. Project settings stay available.',
  },
  proposals: {
    title: 'Proposals',
    intro: (repo: string) => `Changes people propose for ${repo}. Open one to read it, comment and review.`,
    emptyTitle: 'No open proposals',
    emptyBody: 'When someone saves changes in galley, they show up here for the team to read, comment on and approve.',
    emptyAction: 'Open the paper',
    draft: 'Draft',
    by: (login: string) => `by ${login}`,
    updated: (date: string) => `updated ${date}`,
    loadingState: 'Checking reviews',
    tryAgain: 'Try again',
  },
  review: {
    back: 'Back to proposals',
    writeReview: 'Write your review',
    lines: (from: number, to: number) => (from === to ? `Line ${from}` : `Lines ${from}–${to}`),
    mergeOptions: 'Merge options',
    decision: 'Your decision',
    approve: 'Approve',
    askChanges: 'Ask for changes',
    commentOnly: 'Comment only',
    sendComment: 'Send comment',
    opening: (n: number) => `Opening proposal #${n}`,
  },
} as const;

/** Same shape with plain strings, so other languages can say different things. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : { readonly [K in keyof T]: Widen<T[K]> };

export type Messages = Widen<typeof en>;
