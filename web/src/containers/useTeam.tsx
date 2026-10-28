import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AuthRequiredError, type RepoGateway, type Repository, type WorkingState } from '../domain';
import type { TeamGateway } from '../github/team';
import { useT } from '../i18n';
import { CONFIG_PATH, type ProjectConfig } from '../config/project';
import { formatRoute, repoRoute } from '../shell/route';
import { codeownersPath, NEW_CODEOWNERS_PATH, ownersOf, parseCodeowners, setOwners } from '../team/codeowners';
import { canChangeStatus, SECTION_STATUSES, type SectionStatus } from '../team/sections';
import type { Buffers } from '../workspace/model';
import { MenuItem } from '../ui/shell/Menu';
import type { OutlineTeam } from '../ui/team/Badges';

// Team features of the workspace: owners from CODEOWNERS and status from
// `.galley.yml` in the outline, and their edits as pending changes (saved for
// review like any edit). The dialogs are their own chunk.

type DialogsModule = typeof import('../ui/team/TeamDialogs');
let dialogsChunk: Promise<DialogsModule> | undefined;
const loadDialogs = () => (dialogsChunk ??= import('../ui/team/TeamDialogs'));

export interface UseTeamOptions {
  team?: TeamGateway;
  gateway: RepoGateway;
  repo: Repository;
  working?: WorkingState;
  project: ProjectConfig;
  admin: boolean;
  me?: string;
  buffers: Buffers;
  setBuffers: (update: (b: Buffers) => Buffers) => void;
  onReplaced: (path: string) => void;
  notify: (text: string) => void;
  onAuthRequired: () => void;
}

type Dialog = { kind: 'ask'; path: string; name: string } | { kind: 'owners'; path: string; name: string };

export const today = () => new Date().toISOString().slice(0, 10);

/** The galley link of a file, for issue bodies. */
export function galleyLink(repo: Repository, path?: string): string {
  const here = typeof window === 'undefined' ? '' : `${window.location.origin}${window.location.pathname}`;
  return `${here}${formatRoute(path ? { name: 'workspace', ...repoRoute(repo.fullName), path } : { name: 'workspace', ...repoRoute(repo.fullName) })}`;
}

const blobUrl = (repo: Repository, path: string) =>
  `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/blob/${repo.defaultBranch.split('/').map(encodeURIComponent).join('/')}/${path.split('/').map(encodeURIComponent).join('/')}`;

export function useTeam(o: UseTeamOptions) {
  const t = useT();
  const m = t.team;
  const opts = useRef(o);
  opts.current = o;
  const files = o.working?.files;
  const head = o.working?.headSha;
  const ownersPath = files ? codeownersPath(files) : undefined;
  const [loaded, setLoaded] = useState<{ path: string; text: string }>();
  const [dialog, setDialog] = useState<Dialog>();
  const [mod, setMod] = useState<DialogsModule>();
  const [people, setPeople] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [statusEdits, setStatusEdits] = useState<Record<string, SectionStatus>>({});

  useEffect(() => {
    setLoaded(undefined);
    if (!ownersPath || !head) return;
    let active = true;
    opts.current.gateway.readFile(opts.current.repo, ownersPath, head).then(
      (text) => active && setLoaded({ path: ownersPath, text }),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [ownersPath, head]);

  const editedPath = ownersPath ?? (o.buffers[NEW_CODEOWNERS_PATH] ? NEW_CODEOWNERS_PATH : undefined);
  const ownersText = editedPath ? (o.buffers[editedPath]?.text ?? (loaded?.path === editedPath ? loaded.text : '')) : '';
  const rules = useMemo(() => parseCodeowners(ownersText), [ownersText]);
  const configured = o.project.kind === 'valid' ? (o.project.config.sections ?? {}) : {};
  const configDirty = o.buffers[CONFIG_PATH] !== undefined && o.buffers[CONFIG_PATH].text !== o.buffers[CONFIG_PATH].base;

  const fail = (err: unknown, text: string) => {
    if (err instanceof AuthRequiredError) opts.current.onAuthRequired();
    else setError(text);
  };

  const open = (d: Dialog) => {
    setError(undefined);
    setDialog(d);
    loadDialogs().then(setMod, () => setDialog(undefined));
    if (d.kind === 'ask' && opts.current.team && people.length === 0) {
      opts.current.team.assignees(opts.current.repo).then(setPeople, () => undefined);
    }
  };

  const changeStatus = async (path: string, name: string, status: SectionStatus) => {
    const c = opts.current;
    if (c.project.kind !== 'valid' || !c.working) return c.notify(m.statusFailed);
    try {
      const current = c.buffers[CONFIG_PATH];
      const text = current?.text ?? (await c.gateway.readFile(c.repo, CONFIG_PATH, c.working.headSha));
      // configEdit and the schema bring the YAML library: loaded on demand.
      const { setSectionStatus } = await import('../config/configEdit');
      let next = setSectionStatus(text, path, status);
      if (next === undefined) {
        // Flow style or odd layout: rewrite the file (comments are lost, as in Project settings).
        const { serializeConfig } = await import('../config/schema');
        next = serializeConfig({ ...c.project.config, sections: { ...(c.project.config.sections ?? {}), [path]: { status } } });
      }
      const result = next;
      c.setBuffers((b) => ({ ...b, [CONFIG_PATH]: { base: b[CONFIG_PATH]?.base ?? text, text: result } }));
      c.onReplaced(CONFIG_PATH);
      setStatusEdits((s) => ({ ...s, [path]: status }));
      c.notify(m.statusChanged(name, m.status[status]));
    } catch (err) {
      if (err instanceof AuthRequiredError) c.onAuthRequired();
      else c.notify(m.statusFailed);
    }
  };

  const changeOwners = (path: string, name: string, owners: string[]) => {
    const c = opts.current;
    const target = editedPath ?? NEW_CODEOWNERS_PATH;
    const base = c.buffers[target]?.base ?? (loaded?.path === target ? loaded.text : '');
    const next = setOwners(ownersText, path, owners);
    if (next === undefined) return setError(m.cannotWrite);
    c.setBuffers((b) => ({ ...b, [target]: { base: b[target]?.base ?? base, text: next } }));
    c.onReplaced(target);
    setDialog(undefined);
    c.notify(m.ownersChanged(name));
  };

  const sendAsk = async (path: string, name: string, form: { assignee: string; due: string; note: string }) => {
    const c = opts.current;
    if (!c.team) return;
    setBusy(true);
    setError(undefined);
    try {
      await c.team.createAsk(c.repo, { what: name, galleyUrl: galleyLink(c.repo, path), githubUrl: blobUrl(c.repo, path), assignee: form.assignee, due: form.due, note: form.note });
      setDialog(undefined);
      c.notify(m.created(form.assignee));
    } catch (err) {
      fail(err, m.askFailed);
    } finally {
      setBusy(false);
    }
  };

  const outline: OutlineTeam | undefined = o.working
    ? {
        owners: (path) => ownersOf(rules, path),
        status: (path) => {
          const edited = statusEdits[path];
          if (edited) return { status: edited, unsaved: configDirty };
          const s = configured[path]?.status;
          return s ? { status: s, unsaved: false } : undefined;
        },
        menu: (path, name) => {
          const c = opts.current;
          const owners = ownersOf(rules, path);
          const current = statusEdits[path] ?? configured[path]?.status;
          const statusItems =
            c.project.kind === 'valid' && canChangeStatus({ admin: c.admin, me: c.me, owners })
              ? SECTION_STATUSES.filter((s) => s !== current).map((s) => (
                  <MenuItem key={s} onSelect={() => void changeStatus(path, name, s)}>
                    {m.mark[s]}
                  </MenuItem>
                ))
              : [];
          return (
            <>
              {statusItems}
              {c.admin && <MenuItem onSelect={() => open({ kind: 'owners', path, name })}>{m.editOwners}</MenuItem>}
              {c.team && <MenuItem onSelect={() => open({ kind: 'ask', path, name })}>{m.askSomeone}</MenuItem>}
            </>
          );
        },
      }
    : undefined;

  const dialogs =
    dialog && mod ? (
      dialog.kind === 'ask' ? (
        <mod.AskDialog
          what={dialog.name}
          people={people}
          today={today()}
          busy={busy}
          error={error}
          onSubmit={(form) => void sendAsk(dialog.path, dialog.name, form)}
          onClose={() => setDialog(undefined)}
        />
      ) : (
        <mod.OwnersDialog
          name={dialog.name}
          owners={ownersOf(rules, dialog.path)}
          error={error}
          onSubmit={(owners) => changeOwners(dialog.path, dialog.name, owners)}
          onClose={() => setDialog(undefined)}
        />
      )
    ) : null;

  return { outline, dialogs };
}
