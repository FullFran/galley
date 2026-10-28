import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import '../ui/authoring/authoring.css';
import { CONFIG_PATH, type ProjectConfig } from '../config/project';
import type { UploadRule } from '../config/schema';
import type { FileChange, RepoGateway, Repository, WorkingState } from '../domain';
import { useT } from '../i18n';
import { dirname, resolvePath } from '../render/source';
import { readIncludes, type EntryInclude } from '../structure/includes';
import { canChangeStructure } from '../structure/permission';
import type { StructureContext, StructurePlan } from '../structure/plan';
import { describeChange, summaryMessage, type ChangeSummary } from '../structure/summary';
import { SectionDialog, type SectionCheck, type SectionForm } from '../ui/authoring/SectionDialog';
import { UploadDialog, type UploadStep } from '../ui/authoring/UploadDialog';
import type { OutlineStructure } from '../ui/shell/Outline';
import {
  PREVIEWABLE,
  checkContent,
  checkUpload,
  cleanFileName,
  dropInsertion,
  extensionOf,
  figureMarkdown,
  imageType,
  keepBothPath,
  ruleForFolder,
  uploadChange,
  type PendingUpload,
  type UploadProblem,
} from '../uploads/upload';
import type { Buffers } from '../workspace/model';

// Figure uploads and New section / New subsection. Both only prepare pending
// changes: uploads wait as bytes, sections as edited buffers, and everything
// goes into the person's next save as one commit.

type PlanModule = typeof import('../structure/plan');
let planChunk: Promise<PlanModule> | undefined;
const loadPlan = () => {
  planChunk ??= import('../structure/plan');
  planChunk.catch(() => (planChunk = undefined));
  return planChunk;
};

const isProse = (path: string | undefined) => path !== undefined && /\.(qmd|md|markdown)$/i.test(path);

export interface AuthoringOptions {
  gateway: RepoGateway;
  repo: Repository;
  working?: WorkingState;
  project: ProjectConfig;
  admin: boolean;
  buffers: Buffers;
  setBuffers: (update: (b: Buffers) => Buffers) => void;
  openPath?: string;
  /** The main document, where the includes are; read when needed. */
  main: () => string | undefined;
  labelOf: (path: string) => string;
  /** Crossref ids already in the paper. */
  ids: () => ReadonlySet<string>;
  /** The text of this file was replaced: the editor must show the new text. */
  onReplaced: (path: string) => void;
  notify: (text: string) => void;
  /** Inserts text into the open editor (at `at`, else the cursor). */
  insert: (text: string, at?: number) => void;
  /** Whether the open file can take a figure (a document in the editor). */
  canInsert: boolean;
}

interface StructureOp {
  key: number;
  summary: ChangeSummary;
  /** Files the operation changed. */
  paths: string[];
  created?: string;
  id: string;
  label?: { path: string; title: string };
}

interface Loaded {
  base: string;
  text: string;
}

interface DialogState {
  form: SectionForm;
  loading: boolean;
  failed: boolean;
  /** Text by path; null when it could not be read. */
  texts: Record<string, Loaded | null>;
  /** The heading a subsection was asked for, in the open file. */
  heading?: { path: string; line: number; title: string };
}

interface QueueItem {
  file: File;
  folder: string;
  /** Dropped in the editor: insert at this position, then at the cursor. */
  drop?: number | 'cursor';
}

const dirty = (buffers: Buffers, path: string) => {
  const b = buffers[path];
  return b !== undefined && b.text !== b.base;
};

export function useAuthoring(o: AuthoringOptions) {
  const t = useT();
  const a = t.authoring;
  const opts = useRef(o);
  opts.current = o;
  const rules: UploadRule[] = o.project.kind === 'valid' ? o.project.config.uploads : [];

  // ---- uploads ----
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;
  const [step, setStep] = useState<UploadStep>();
  const queue = useRef<QueueItem[]>([]);
  const current = useRef<{ bytes: Uint8Array; path: string; name: string; drop?: number | 'cursor'; url?: string; keepBothPath?: string }>(undefined);
  const seq = useRef(0);
  const busy = useRef(false);

  // ---- structure ----
  const [ops, setOps] = useState<StructureOp[]>([]);
  const [savedLabels, setSavedLabels] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<DialogState>();
  const [mod, setMod] = useState<PlanModule>();

  // Revoke preview URLs when the dialog moves on or the workspace closes.
  useEffect(() => () => revoke(), []);
  const revoke = () => {
    if (current.current?.url) URL.revokeObjectURL(current.current.url);
  };

  const repoFiles = () => new Set(opts.current.working?.files ?? []);
  const liveOps = ops.filter((op) => op.paths.some((p) => dirty(o.buffers, p)));
  const created = liveOps.flatMap((op) => (op.created && o.buffers[op.created] ? [op.created] : []));
  const pendingPaths = new Set([...created, ...uploads.map((u) => u.path)]);
  const exists = (path: string) =>
    repoFiles().has(path) || uploadsRef.current.some((u) => u.path === path) || opts.current.buffers[path] !== undefined;

  const problemText = (p: UploadProblem): string => {
    switch (p.kind) {
      case 'type':
        return a.problemType(p.accept.join(', '));
      case 'size':
        return a.problemSize(p.maxSizeMb);
      case 'empty':
        return a.problemEmpty;
      case 'name':
        return a.problemName;
      case 'content':
        return a.problemContent;
    }
  };

  const addUpload = (path: string, bytes: Uint8Array) => {
    const replace = repoFiles().has(path);
    seq.current += 1;
    const id = seq.current;
    setUploads((u) => [...u.filter((x) => x.path !== path), { id, path, bytes, replace }]);
  };

  const insertDrop = (path: string, drop: number | 'cursor') => {
    const main = opts.current.main() ?? opts.current.openPath ?? '';
    opts.current.insert(dropInsertion(path, main), drop === 'cursor' ? undefined : drop);
    // Later files of the same drop follow at the cursor.
    for (const item of queue.current) if (item.drop !== undefined) item.drop = 'cursor';
  };

  const next = async (): Promise<void> => {
    revoke();
    current.current = undefined;
    const item = queue.current.shift();
    if (!item) {
      busy.current = false;
      setStep(undefined);
      return;
    }
    busy.current = true;
    const name = item.file.name;
    const rule = ruleForFolder(rules, item.folder);
    if (!rule) return setStep({ kind: 'problem', name, message: a.noUploadFolder });
    // Name, type and size are checked before reading the file.
    const problem = checkUpload(item.file, rule);
    if (problem) return setStep({ kind: 'problem', name, message: problemText(problem) });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await item.file.arrayBuffer());
    } catch {
      return setStep({ kind: 'problem', name, message: a.problemRead });
    }
    if (bytes.length > rule.maxSizeMb * 1024 * 1024) return setStep({ kind: 'problem', name, message: a.problemSize(rule.maxSizeMb) });
    if (!checkContent(bytes, name)) return setStep({ kind: 'problem', name, message: problemText({ kind: 'content' }) });
    const clean = cleanFileName(name) ?? name;
    const path = `${rule.folder}${clean}`;
    const taken = exists(path);
    if (item.drop !== undefined && !taken) {
      addUpload(path, bytes);
      insertDrop(path, item.drop);
      opts.current.notify(a.added(a.summaryUpload(clean)));
      return next();
    }
    const type = imageType(clean);
    const url = type && PREVIEWABLE.has(extensionOf(clean)) ? URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type })) : undefined;
    const keep = taken ? keepBothPath(path, exists) : undefined;
    current.current = { bytes, path, name: clean, drop: item.drop, url, keepBothPath: keep };
    setStep({ kind: 'confirm', name: clean, path, url, keepBothPath: keep });
  };

  const enqueue = (items: QueueItem[]) => {
    queue.current.push(...items);
    if (!busy.current) void next();
  };

  const onUpload = (folder: string, files: File[]) => enqueue(files.map((file) => ({ file, folder })));

  const onEditorDrop = (files: File[], pos: number) => {
    if (!opts.current.canInsert) return opts.current.notify(a.insertNeedsDocument);
    const folder = rules[0]?.folder;
    if (!folder) return opts.current.notify(a.noUploadFolder);
    enqueue(files.map((file, i) => ({ file, folder, drop: i === 0 ? pos : 'cursor' })));
  };

  const onAdd = (choice: 'add' | 'replace' | 'keep-both') => {
    const cur = current.current;
    if (!cur) return;
    const path = choice === 'keep-both' && cur.keepBothPath ? cur.keepBothPath : cur.path;
    addUpload(path, cur.bytes);
    if (cur.drop !== undefined) {
      insertDrop(path, cur.drop);
      void next();
      return;
    }
    setStep({ kind: 'added', name: cur.name, path, url: cur.url, canInsert: opts.current.canInsert });
  };

  const onInsertFigure = (caption: string) => {
    if (step?.kind !== 'added') return;
    const main = opts.current.main() ?? opts.current.openPath ?? '';
    opts.current.insert(figureMarkdown(step.path, caption, main));
    void next();
  };

  const closeUpload = () => {
    if (step === undefined && !busy.current) return;
    void next();
  };

  // ---- New section / New subsection ----

  const read = async (path: string): Promise<Loaded | null> => {
    const b = opts.current.buffers[path];
    if (b) return { base: b.base, text: b.text };
    const head = opts.current.working?.headSha;
    if (!head) return null;
    try {
      const text = await opts.current.gateway.readFile(opts.current.repo, path, head);
      return { base: text, text };
    } catch {
      return null;
    }
  };

  const includesOf = (d: DialogState | undefined): EntryInclude[] => {
    const main = opts.current.main();
    const text = main ? d?.texts[main]?.text : undefined;
    if (!main || text === undefined) return [];
    const list = readIncludes(main, text);
    return 'error' in list ? [] : list.includes;
  };

  const parentOf = (d: DialogState, key: string): { path: string; line?: number; title?: string } | undefined => {
    if (key.startsWith('h:') && d.heading) return { path: d.heading.path, line: d.heading.line, title: d.heading.title };
    if (key.startsWith('f:')) return { path: key.slice(2) };
    return undefined;
  };

  const ensureLoaded = (paths: string[]) => {
    setDialog((d) => d && { ...d, loading: true });
    void Promise.all([loadPlan(), ...paths.map(async (p) => [p, await read(p)] as const)]).then(
      ([m, ...entries]) => {
        setMod(m);
        setDialog((d) => d && { ...d, loading: false, texts: { ...d.texts, ...Object.fromEntries(entries) } });
      },
      () => setDialog((d) => d && { ...d, loading: false, failed: true }),
    );
  };

  const openDialog = (kind: SectionForm['kind'], init: { after?: number | 'start'; parent?: string; heading?: DialogState['heading'] }) => {
    const main = opts.current.main();
    const files = repoFiles();
    const paths = [main, opts.current.admin && files.has(CONFIG_PATH) ? CONFIG_PATH : undefined].filter((p): p is string => p !== undefined);
    const parentPath = init.parent?.startsWith('f:') ? init.parent.slice(2) : init.heading?.path;
    if (parentPath && !paths.includes(parentPath)) paths.push(parentPath);
    setDialog({
      form: { kind, title: '', after: init.after ?? -1, parent: init.parent ?? '', fileName: '', id: '', advanced: false },
      loading: true,
      failed: false,
      texts: {},
      heading: init.heading,
    });
    ensureLoaded(paths);
  };

  // Defaults that need the entry text: the position after the open section, and a parent.
  useEffect(() => {
    if (!dialog || dialog.loading) return;
    const includes = includesOf(dialog);
    const { form } = dialog;
    let patch: Partial<SectionForm> | undefined;
    if (form.after === -1) {
      const open = opts.current.openPath;
      const here = includes.find((i) => i.path === open) ?? includes[includes.length - 1];
      patch = { after: here ? here.line : 'start' };
    }
    if (form.parent === '') {
      const open = opts.current.openPath;
      const first = dialog.heading ? 'h:' : open && includes.some((i) => i.path === open) ? `f:${open}` : includes[0] ? `f:${includes[0].path}` : '';
      if (first) patch = { ...patch, parent: first };
    }
    if (patch) setDialog((d) => d && { ...d, form: { ...d.form, ...patch } });
    // A newly chosen parent file is read once.
    const parent = parentOf(dialog, form.parent);
    if (form.kind === 'subsection' && parent && !(parent.path in dialog.texts)) ensureLoaded([parent.path]);
  }, [dialog]);

  const plan: StructurePlan | undefined = useMemo(() => {
    const main = o.main();
    if (!dialog || dialog.loading || !mod || !main || dialog.form.after === -1) return undefined;
    const { form, texts } = dialog;
    const ids = new Set([...o.ids(), ...liveOps.map((op) => op.id)]);
    const files = new Set([...(o.working?.files ?? []), ...pendingPaths]);
    const parent = parentOf(dialog, form.parent);
    const ctx: StructureContext = {
      entry: main,
      entryText: texts[main]?.text,
      files,
      ids,
      admin: o.admin,
      project: o.project,
      configText: o.admin ? (texts[CONFIG_PATH]?.text ?? undefined) : undefined,
      parentText: parent ? (texts[parent.path]?.text ?? undefined) : undefined,
      labelOf: o.labelOf,
    };
    if (form.kind === 'section') {
      return mod.planSection({ title: form.title, after: form.after, fileName: form.fileName || undefined, id: form.id || undefined }, ctx);
    }
    return mod.planSubsection({ title: form.title, parent: parent ?? { path: '' }, id: form.id || undefined }, ctx);
    // `o` changes every render; the plan depends on the dialog and the module.
  }, [dialog, mod, o.buffers, o.project, o.admin]);

  const folderOf = (path?: string) => (path ? path.slice(0, path.lastIndexOf('/') + 1) : '');
  const check: SectionCheck | undefined = plan && {
    problems: plan.problems.map((p) => a.problems[p.code]),
    warnings: plan.warnings.map((w) => a.warnings[w.code]),
    path: plan.proposal.path,
    id: plan.proposal.id,
    folder: folderOf(plan.proposal.path),
  };

  const submitSection = () => {
    if (!dialog || !plan || plan.problems.length > 0 || plan.changes.length === 0) return;
    const texts = dialog.texts;
    o.setBuffers((b) => {
      const nextBuffers = { ...b };
      for (const c of plan.changes) {
        const cur = nextBuffers[c.path];
        const base = cur?.base ?? (c.created ? '' : (texts[c.path]?.base ?? ''));
        nextBuffers[c.path] = { base, text: c.text };
      }
      return nextBuffers;
    });
    for (const c of plan.changes) o.onReplaced(c.path);
    const createdPath = plan.changes.find((c) => c.created)?.path;
    const labelled = createdPath && plan.changes.some((c) => c.path === CONFIG_PATH) ? { path: createdPath, title: plan.summary.kind === 'upload' ? '' : plan.summary.title } : undefined;
    seq.current += 1;
    const op: StructureOp = { key: seq.current, summary: plan.summary, paths: plan.changes.map((c) => c.path), created: createdPath, id: plan.proposal.id, label: labelled };
    setOps((list) => [...list, op]);
    o.notify(a.added(describeChange(plan.summary, t)));
    setDialog(undefined);
  };

  const parents = (() => {
    if (!dialog) return [];
    const includes = includesOf(dialog);
    const list = includes.map((i) => ({ key: `f:${i.path}`, label: o.labelOf(i.path) }));
    const open = o.openPath;
    if (open && open !== o.main() && isProse(open) && !includes.some((i) => i.path === open)) list.unshift({ key: `f:${open}`, label: o.labelOf(open) });
    if (dialog.heading) list.unshift({ key: 'h:', label: dialog.heading.title });
    return list;
  })();
  const positions = dialog
    ? [{ value: 'start' as const, label: a.atStart }, ...includesOf(dialog).map((i) => ({ value: i.line, label: a.after(o.labelOf(i.path)) }))]
    : [];

  const structure: OutlineStructure | undefined =
    o.working && canChangeStructure(o.project, o.admin)
      ? {
          onNewSection: (after) => openDialog('section', { after }),
          onNewSubsection: (target) => {
            const open = opts.current.openPath;
            if (target.line !== undefined && open) return openDialog('subsection', { heading: { path: open, line: target.line, title: target.title } });
            const resolved = target.path && open ? resolvePath(dirname(open), target.path) : undefined;
            return openDialog('subsection', { parent: resolved ? `f:${resolved}` : undefined });
          },
        }
      : undefined;

  // ---- the save ----

  const summaries: ChangeSummary[] = [
    ...liveOps.map((op) => op.summary),
    ...uploads.map((u): ChangeSummary => ({ kind: 'upload', name: u.path.slice(u.path.lastIndexOf('/') + 1), replace: u.replace })),
  ];
  const pending = [
    ...liveOps.map((op) => ({ key: `s${op.key}`, text: describeChange(op.summary, t) })),
    ...uploads.map((u) => ({
      key: `u${u.id}`,
      text: describeChange({ kind: 'upload', name: u.path.slice(u.path.lastIndexOf('/') + 1), replace: u.replace }, t),
      onRemove: () => setUploads((list) => list.filter((x) => x.id !== u.id)),
    })),
  ];
  const labels: Record<string, string> = { ...savedLabels };
  for (const op of liveOps) if (op.label) labels[op.label.path] = op.label.title;

  /** The uploads to add to a save, and a token to report what was saved. */
  const extra = (): { changes: FileChange[]; ids: number[] } => ({
    changes: uploadsRef.current.map(uploadChange),
    ids: uploadsRef.current.map((u) => u.id),
  });

  /** A save landed: drop what it contained from the pending lists. */
  const committed = (ids: number[]) => {
    setUploads((list) => list.filter((u) => !ids.includes(u.id)));
    setSavedLabels((l) => ({ ...l, ...labels }));
  };

  /** Reads a pending upload for the preview, else the repository. */
  const previewGateway = useMemo<RepoGateway>(() => {
    const byPath = new Map(uploads.map((u) => [u.path, u.bytes]));
    if (byPath.size === 0) return o.gateway;
    return { ...o.gateway, readBytes: (repo, path, ref) => (byPath.has(path) ? Promise.resolve(byPath.get(path) as Uint8Array) : o.gateway.readBytes(repo, path, ref)) };
  }, [o.gateway, uploads]);

  const dialogs = (
    <>
      <UploadDialog step={step} onAdd={onAdd} onInsert={onInsertFigure} onClose={closeUpload} />
      <SectionDialog
        open={dialog !== undefined}
        loading={dialog?.loading ?? false}
        failed={dialog?.failed ?? false}
        form={dialog?.form ?? { kind: 'section', title: '', after: 'start', parent: '', fileName: '', id: '', advanced: false }}
        positions={positions}
        parents={parents}
        check={check}
        onChange={(form) => setDialog((d) => d && { ...d, form })}
        onSubmit={submitSection}
        onClose={() => setDialog(undefined)}
      />
    </>
  );

  return {
    uploads,
    uploadRules: rules,
    pendingPaths,
    created,
    labels,
    pending,
    defaultMessage: summaryMessage(summaries, t),
    structure,
    onUpload,
    onEditorDrop,
    extra,
    committed,
    previewGateway,
    dialogs,
  };
}
