import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  AuthRequiredError,
  type ChangedFile,
  type MergeMethod,
  type NewComment,
  type Person,
  type Proposal,
  type ProposalFiles,
  type RepoAccess,
  type RepoGateway,
  type Repository,
  type Review,
  type ReviewComment,
  type ReviewEvent,
  type ReviewGateway,
} from '../domain';
import { rightLines } from '../review/diff';
import { describeReviewError } from '../review/labels';
import { splitByHead } from '../review/pending';
import { reviewerStatuses } from '../review/status';
import { applySuggestion, suggestionBlock } from '../review/suggestion';
import { groupThreads } from '../review/threads';
import type { Buffers } from '../workspace/model';
import { FileDiff, type CommentDraft } from '../ui/review/FileDiff';
import { GitHubLink } from '../ui/review/GitHubLink';
import { MergeBox, People, ReviewForm } from '../ui/review/SidePanel';
import { StaleComments } from '../ui/review/StaleComments';
import { Preview } from './Preview';

export interface ProposalDetailProps {
  repos: RepoGateway;
  reviews: ReviewGateway;
  repo: Repository;
  number: number;
  onBack: () => void;
  onAuthRequired: () => void;
}

interface Loaded {
  proposal: Proposal;
  files: ChangedFile[];
  comments: ReviewComment[];
  reviews: Review[];
}

type Notice = { kind: 'ok' | 'error'; text: string };

/** A comment kept for the review, with the head its line numbers refer to. */
type Queued = NewComment & { headSha: string };

const NO_ACCESS: RepoAccess = { canPush: false, admin: false, mergeMethods: [] };
// The preview of a proposal is read-only: no open buffers.
const NO_BUFFERS: Buffers = {};

export function ProposalDetail({ repos, reviews, repo, number, onBack, onAuthRequired }: ProposalDetailProps) {
  const [data, setData] = useState<Loaded>();
  const [loadError, setLoadError] = useState<string>();
  const [access, setAccess] = useState<RepoAccess>(NO_ACCESS);
  const [candidates, setCandidates] = useState<Person[]>([]);
  const [me, setMe] = useState<Person>();
  const [composer, setComposer] = useState<CommentDraft>();
  const [pending, setPending] = useState<Queued[]>([]);
  const [stale, setStale] = useState<NewComment[]>([]);
  const [replyDrafts, setReplyDrafts] = useState<Record<number, string>>({});
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [reviewBody, setReviewBody] = useState('');
  const [method, setMethod] = useState<MergeMethod>('merge');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [preview, setPreview] = useState<ProposalFiles & { sha: string }>();

  const fail = useCallback(
    (err: unknown, show: (text: string) => void) => {
      if (err instanceof AuthRequiredError) onAuthRequired();
      else show(describeReviewError(err));
    },
    [onAuthRequired],
  );

  const load = useCallback(async () => {
    try {
      const [proposal, files, comments, list] = await Promise.all([
        reviews.getProposal(repo, number),
        reviews.listChangedFiles(repo, number),
        reviews.listReviewComments(repo, number),
        reviews.listReviews(repo, number),
      ]);
      setLoadError(undefined);
      setData({ proposal, files, comments, reviews: list });
    } catch (err) {
      fail(err, setLoadError);
    }
  }, [reviews, repo, number, fail]);

  useEffect(() => {
    void load();
    // Optional extras: without them the page still works, with fewer actions.
    reviews.access(repo).then((a) => {
      setAccess(a);
      if (a.mergeMethods[0]) setMethod(a.mergeMethods[0]);
    }, () => undefined);
    reviews.listCandidates(repo).then(setCandidates, () => undefined);
    reviews.currentUser().then(setMe, () => undefined);
  }, [load, reviews, repo]);

  // When the head moves (a suggestion was applied, someone pushed), drafts written
  // against the old head are not sent: their line numbers may point elsewhere.
  const head = data?.proposal.headSha;
  useEffect(() => {
    if (!head) return;
    const split = splitByHead(pending, head);
    const dropped: NewComment[] = [...split.stale];
    if (composer && composer.headSha !== head) {
      if (composer.text.trim()) dropped.push({ path: composer.path, side: composer.side, line: composer.line, body: composer.text });
      setComposer(undefined);
    }
    if (split.stale.length > 0) setPending(split.current);
    if (dropped.length > 0) setStale((s) => [...s, ...dropped]);
    // Runs only when the head changes.
  }, [head]);

  /** Runs one action, then reloads the proposal. */
  const act = async (run: () => Promise<unknown>, done?: string) => {
    if (busy) return false;
    setBusy(true);
    setNotice(undefined);
    try {
      await run();
      if (done) setNotice({ kind: 'ok', text: done });
      await load();
      return true;
    } catch (err) {
      fail(err, (text) => setNotice({ kind: 'error', text }));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <main class="page">
        <p class="banner banner-error" role="alert">
          {loadError}{' '}
          <button type="button" onClick={() => void load()}>
            Try again
          </button>{' '}
          <button type="button" onClick={onBack}>
            Back to proposals
          </button>
        </p>
      </main>
    );
  }
  if (!data) return <main class="page muted">Opening proposal #{number}…</main>;

  const { proposal, files } = data;
  const threads = groupThreads(data.comments);
  const open = proposal.state === 'open';
  const canApply = open && proposal.sameRepo && access.canPush;
  const queued = splitByHead(pending, proposal.headSha).current;
  const ownProposal = me !== undefined && proposal.author?.login === me.login;

  /** The comment being written, as GitHub expects it; undefined (with a notice) if the range is wrong. */
  const draftComment = (): NewComment | undefined => {
    if (!composer) return undefined;
    const raw = composer.startLine.trim();
    const start = raw === '' ? undefined : Number(raw);
    if (start !== undefined && (!Number.isInteger(start) || start < 1 || start > composer.line)) {
      setNotice({ kind: 'error', text: `"From line" must be a line number between 1 and ${composer.line}.` });
      return undefined;
    }
    if (composer.headSha !== proposal.headSha) return undefined;
    return { path: composer.path, side: composer.side, line: composer.line, startLine: start, body: composer.text };
  };

  const sendComment = async () => {
    const comment = draftComment();
    if (comment && (await act(() => reviews.addComment(repo, number, proposal.headSha, comment), 'Comment sent.'))) {
      setComposer(undefined);
    }
  };

  const queueComment = () => {
    const comment = draftComment();
    if (!comment) return;
    setPending((p) => [...p, { ...comment, headSha: proposal.headSha }]);
    setComposer(undefined);
  };

  const suggest = () => {
    if (!composer) return;
    const patch = files.find((f) => f.path === composer.path)?.patch ?? '';
    const start = Number(composer.startLine.trim() || composer.line);
    const lines = Number.isInteger(start) ? rightLines(patch, start, composer.line) : undefined;
    if (!lines) {
      setNotice({ kind: 'error', text: 'Suggestions can only cover lines shown in the changes.' });
      return;
    }
    const block = suggestionBlock(lines);
    setComposer({ ...composer, text: composer.text ? `${composer.text}\n${block}` : block });
  };

  const reply = async (rootId: number) => {
    const body = replyDrafts[rootId]?.trim();
    if (body && (await act(() => reviews.reply(repo, number, rootId, body), 'Reply sent.'))) {
      setReplyDrafts((drafts) => ({ ...drafts, [rootId]: '' }));
    }
  };

  const submit = async () => {
    const sent = await act(
      () => reviews.submitReview(repo, number, { event, body: reviewBody.trim(), commitId: proposal.headSha, comments: queued }),
      'Review sent.',
    );
    if (sent) {
      setPending([]);
      setReviewBody('');
      setEvent('COMMENT');
    }
  };

  const apply = (comment: ReviewComment) => {
    if (!window.confirm('Apply this suggestion as a new change to the proposal?')) return;
    void act(() => applySuggestion({ repos, reviews }, repo, proposal, access, comment), 'Suggestion applied.');
  };

  const merge = () => {
    if (!window.confirm(`Merge "${proposal.title}" into ${proposal.baseBranch}? This cannot be undone from galley.`)) return;
    void act(() => reviews.merge(repo, number, proposal.headSha, method), 'Merged.');
  };

  const showPreview = async () => {
    if (preview?.sha === proposal.headSha) return setPreview(undefined);
    try {
      setPreview({ ...(await reviews.listFiles(repo, proposal.headSha)), sha: proposal.headSha });
    } catch (err) {
      fail(err, (text) => setNotice({ kind: 'error', text }));
    }
  };

  const people = (fn: (logins: string[]) => Promise<void>, done: string) => (login: string) =>
    void act(() => fn([login]), done);

  return (
    <main class="proposal">
      <div class="proposal-main">
        <p>
          <button type="button" onClick={onBack}>
            Back to proposals
          </button>
        </p>
        <h2 class="proposal-heading">{proposal.title}</h2>
        <p class="muted">
          #{proposal.number}
          {proposal.author && ` by ${proposal.author.login}`} · {proposal.state === 'merged' ? 'merged' : proposal.state}{' '}
          <GitHubLink href={proposal.htmlUrl} />
        </p>
        {proposal.body && <p class="comment-body">{proposal.body}</p>}
        {notice && (
          <p class={`banner banner-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
            {notice.text}
          </p>
        )}
        <StaleComments comments={stale} onDismiss={() => setStale([])} />
        <div class="actions">
          <button type="button" onClick={() => void showPreview()}>
            {preview?.sha === proposal.headSha ? 'Hide preview' : 'Preview this version'}
          </button>
          <button type="button" disabled={busy} onClick={() => void act(async () => undefined)}>
            Reload
          </button>
        </div>
        {preview?.sha === proposal.headSha && (
          <section class="proposal-preview" aria-label="Preview of this version">
            <Preview gateway={repos} repo={repo} headSha={preview.sha} files={preview.files} buffers={NO_BUFFERS} />
          </section>
        )}
        <h3>Changes ({files.length} {files.length === 1 ? 'file' : 'files'})</h3>
        {files.map((file) => (
          <FileDiff
            key={file.path}
            file={file}
            threads={threads.filter((t) => t.root.path === file.path)}
            pending={queued.filter((c) => c.path === file.path)}
            composer={composer}
            replyDrafts={replyDrafts}
            canApply={canApply}
            busy={busy}
            onStartComment={(path, side, line) =>
              setComposer({ headSha: proposal.headSha, path, side, line, startLine: '', text: '' })
            }
            onComposer={(change) => setComposer((c) => c && { ...c, ...change })}
            onSendComment={() => void sendComment()}
            onQueueComment={queueComment}
            onCancelComment={() => setComposer(undefined)}
            onSuggest={suggest}
            onReplyDraft={(id, text) => setReplyDrafts((d) => ({ ...d, [id]: text }))}
            onReply={(id) => void reply(id)}
            onApply={apply}
          />
        ))}
      </div>
      <aside class="proposal-side">
        <People
          reviewers={reviewerStatuses(proposal.requestedReviewers, data.reviews)}
          assignees={proposal.assignees}
          candidates={candidates}
          canEdit={open && access.canPush}
          editHint={open ? 'Only people who can change this repository can ask for reviews or assign people.' : undefined}
          busy={busy}
          onRequest={people((l) => reviews.requestReviewers(repo, number, l), 'Review requested.')}
          onRemoveReviewer={people((l) => reviews.removeReviewers(repo, number, l), 'Review request removed.')}
          onAssign={people((l) => reviews.addAssignees(repo, number, l), 'Assigned.')}
          onUnassign={people((l) => reviews.removeAssignees(repo, number, l), 'Unassigned.')}
        />
        {open && (
          <ReviewForm
            event={event}
            body={reviewBody}
            pendingCount={queued.length}
            ownProposal={ownProposal}
            busy={busy}
            onEvent={setEvent}
            onBody={setReviewBody}
            onSubmit={() => void submit()}
          />
        )}
        <MergeBox proposal={proposal} access={access} method={method} busy={busy} onMethod={setMethod} onMerge={merge} />
      </aside>
    </main>
  );
}
