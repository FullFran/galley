import { addEditable, addLabel } from '../config/configEdit';
import { matchAny } from '../config/glob';
import { CONFIG_PATH, type ProjectConfig } from '../config/project';
import { parseConfig, serializeConfig } from '../config/schema';
import { relativePath } from '../uploads/upload';
import { detectConvention, sectionPath } from './convention';
import { insertInclude, insertSubsection, readIncludes } from './includes';
import { canChangeStructure } from './permission';
import { slugify } from './slug';
import type { ChangeSummary } from './summary';

// New section / New subsection as a plan of text changes: a new file with
// its heading, the include at the chosen place in the entry file and, for
// admins, the label (and editable coverage) in `.galley.yml`. Nothing is
// written here; the workspace puts the changes in the person's next save.

export interface SectionRequest {
  title: string;
  /** Line of the include in the entry file the new section follows, or `start`. */
  after: number | 'start';
  /** Advanced: file name inside the section folder. */
  fileName?: string;
  /** Advanced: the section id, `sec-…`. */
  id?: string;
}

export interface SubsectionRequest {
  title: string;
  /** The file to add the heading to and, optionally, the heading it goes under. */
  parent: { path: string; line?: number; title?: string };
  id?: string;
}

export interface StructureContext {
  entry: string;
  /** Current text of the entry file (the buffer when it is open); undefined when it cannot be read. */
  entryText?: string;
  /** Every path in the repository, plus files waiting to be saved. */
  files: ReadonlySet<string>;
  /** Every crossref id in the paper. */
  ids: ReadonlySet<string>;
  admin: boolean;
  project: ProjectConfig;
  /** Current `.galley.yml` text; only given to admins, who may change it. */
  configText?: string;
  /** Current text of the parent file (subsections). */
  parentText?: string;
  labelOf: (path: string) => string;
}

export type ProblemCode =
  | 'title-empty'
  | 'title-chars'
  | 'title-long'
  | 'permission'
  | 'entry-missing'
  | 'includes-unparseable'
  | 'file-exists'
  | 'file-invalid'
  | 'file-reserved'
  | 'id-invalid'
  | 'id-duplicate'
  | 'not-editable'
  | 'config-unparseable'
  | 'parent-missing';

export type WarningCode = 'label-duplicate' | 'config-skipped';

export interface PlannedChange {
  path: string;
  text: string;
  /** A new file. */
  created?: boolean;
}

export interface StructurePlan {
  problems: { code: ProblemCode; detail?: string }[];
  warnings: { code: WarningCode; detail?: string }[];
  /** Empty while there are problems. */
  changes: PlannedChange[];
  summary: ChangeSummary;
  /** The file and id galley would use (shown under Advanced). */
  proposal: { path?: string; id: string };
}

export const MAX_TITLE = 120;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,58}\.(qmd|md)$/;
const SECTION_ID = /^sec-[a-z0-9][a-z0-9-]{0,60}$/;
// Names that already mean something to Quarto, GitHub or Windows.
const RESERVED = new Set([
  'index', 'readme', 'license', 'licence', 'references', 'bibliography', 'quarto', 'metadata', 'galley',
  'con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function titleProblems(title: string): StructurePlan['problems'] {
  if (title === '') return [{ code: 'title-empty' }];
  if (CONTROL.test(title) || /[{}]/.test(title)) return [{ code: 'title-chars' }];
  if (title.length > MAX_TITLE) return [{ code: 'title-long' }];
  return [];
}

function idProblems(id: string, ids: ReadonlySet<string>): StructurePlan['problems'] {
  if (!SECTION_ID.test(id)) return [{ code: 'id-invalid', detail: id }];
  if (ids.has(id)) return [{ code: 'id-duplicate', detail: id }];
  return [];
}

const stemOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.slice(0, name.lastIndexOf('.')).replace(/^_+/, '').toLowerCase();
};

/** `.galley.yml` with the new file labelled and covered by `editable`, comments kept when possible. */
function configWith(text: string, path: string, title: string): string | undefined {
  const current = parseConfig(text).config;
  if (!current) return undefined;
  const covered = matchAny(current.editable, path);
  let next = addLabel(text, path, title);
  if (next !== undefined && !covered) next = addEditable(next, path);
  const check = next === undefined ? undefined : parseConfig(next).config;
  if (check && check.labels[path] === title && matchAny(check.editable, path)) return next;
  return serializeConfig({
    ...current,
    labels: { ...current.labels, [path]: title },
    editable: covered ? current.editable : [...current.editable, path],
  });
}

export function planSection(req: SectionRequest, ctx: StructureContext): StructurePlan {
  const title = req.title.trim();
  const slug = slugify(title);
  const id = req.id?.trim() || `sec-${slug || 'section'}`;
  const plan = (over: Partial<StructurePlan> & Pick<StructurePlan, 'summary'>): StructurePlan => ({
    problems: [],
    warnings: [],
    changes: [],
    proposal: { id },
    ...over,
  });
  const fail = (problems: StructurePlan['problems'], summary: ChangeSummary = { kind: 'section', title }) => plan({ problems, summary });

  if (!canChangeStructure(ctx.project, ctx.admin)) return fail([{ code: 'permission' }]);
  if (ctx.entryText === undefined) return fail([{ code: 'entry-missing' }]);
  const list = readIncludes(ctx.entry, ctx.entryText);
  if ('error' in list) return fail([{ code: 'includes-unparseable' }]);

  const { includes, style } = list;
  // The include the new section follows; -1 is the start. An unknown line means the end.
  let index = req.after === 'start' ? -1 : includes.findIndex((i) => i.line === req.after);
  if (req.after !== 'start' && index < 0) index = includes.length - 1;
  const prev = index >= 0 ? includes[index] : undefined;
  const position: number | 'start' = prev ? prev.line : 'start';
  const next = includes[index + 1];
  const summary: ChangeSummary = prev ? { kind: 'section', title, after: ctx.labelOf(prev.path) } : { kind: 'section', title };

  const conv = detectConvention(ctx.entry, includes);
  const problems: StructurePlan['problems'] = [...titleProblems(title)];
  const fileName = req.fileName?.trim();
  let path: string | undefined;
  if (fileName) {
    if (!FILE_NAME.test(fileName)) problems.push({ code: 'file-invalid', detail: fileName });
    else path = `${conv.folder}${fileName}`;
  } else path = sectionPath(slug, conv, { prev: prev?.path, next: next?.path }, [...ctx.files]);
  if (path !== undefined) {
    if (RESERVED.has(stemOf(path))) problems.push({ code: 'file-reserved', detail: path });
    else if (ctx.files.has(path)) problems.push({ code: 'file-exists', detail: path });
  }
  problems.push(...idProblems(id, ctx.ids));

  const warnings: StructurePlan['warnings'] = [];
  const labels = ctx.project.kind === 'valid' ? ctx.project.config.labels : {};
  if (title && Object.values(labels).some((l) => l.trim().toLowerCase() === title.toLowerCase())) {
    warnings.push({ code: 'label-duplicate', detail: title });
  }

  let configText: string | undefined;
  if (path !== undefined && ctx.project.kind === 'valid') {
    if (ctx.admin) {
      if (ctx.configText !== undefined) {
        configText = configWith(ctx.configText, path, title || path);
        if (configText === undefined) problems.push({ code: 'config-unparseable' });
      }
    } else {
      if (!matchAny(ctx.project.config.editable, path)) problems.push({ code: 'not-editable', detail: path });
      if (!matchAny(ctx.project.config.editable, ctx.entry)) problems.push({ code: 'not-editable', detail: ctx.entry });
    }
  } else if (ctx.admin && ctx.project.kind === 'invalid') warnings.push({ code: 'config-skipped' });

  const proposal = { path, id };
  if (problems.length > 0 || path === undefined) return plan({ problems, warnings, summary, proposal });
  const changes: PlannedChange[] = [
    { path, text: `# ${title} {#${id}}\n\n`, created: true },
    { path: ctx.entry, text: insertInclude(ctx.entryText, relativePath(ctx.entry, path), position, style) },
  ];
  if (configText !== undefined) changes.push({ path: CONFIG_PATH, text: configText });
  return plan({ warnings, changes, summary, proposal });
}

export function planSubsection(req: SubsectionRequest, ctx: StructureContext): StructurePlan {
  const title = req.title.trim();
  const id = req.id?.trim() || `sec-${slugify(title) || 'section'}`;
  const summary: ChangeSummary = { kind: 'subsection', title, parent: req.parent.title ?? ctx.labelOf(req.parent.path) };
  const result = (problems: StructurePlan['problems'], changes: PlannedChange[] = []): StructurePlan => ({
    problems,
    warnings: [],
    changes,
    summary,
    proposal: { id },
  });
  if (!canChangeStructure(ctx.project, ctx.admin)) return result([{ code: 'permission' }]);
  if (ctx.parentText === undefined) return result([{ code: 'parent-missing' }]);
  const problems = [...titleProblems(title), ...idProblems(id, ctx.ids)];
  if (!ctx.admin && ctx.project.kind === 'valid' && !matchAny(ctx.project.config.editable, req.parent.path)) {
    problems.push({ code: 'not-editable', detail: req.parent.path });
  }
  if (problems.length > 0) return result(problems);
  return result([], [{ path: req.parent.path, text: insertSubsection(ctx.parentText, title, id, req.parent.line) }]);
}
