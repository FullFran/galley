package pbstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/FullFran/galley/server/internal/comments"
)

// CommentStore implements comments.Store. It never sees plaintext comment
// bodies, suggestions or quotes: the service seals them first.
type CommentStore struct {
	app core.App
}

var _ comments.Store = (*CommentStore)(nil)

// NewCommentStore returns a CommentStore backed by app.
func NewCommentStore(app core.App) *CommentStore {
	return &CommentStore{app: app}
}

// CreateThread implements comments.Store.
func (s *CommentStore) CreateThread(_ context.Context, t comments.ThreadRecord, first comments.CommentRecord) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		tcol, err := tx.FindCollectionByNameOrId(ThreadsCollection)
		if err != nil {
			return err
		}
		rec := core.NewRecord(tcol)
		rec.Id = t.ID
		setThread(rec, t)
		rec.Set("comment_seq", 1)
		if err := tx.Save(rec); err != nil {
			return err
		}
		return saveComment(tx, first, 1)
	})
}

// Thread implements comments.Store.
func (s *CommentStore) Thread(_ context.Context, id string) (comments.ThreadRecord, error) {
	rec, err := s.app.FindRecordById(ThreadsCollection, id)
	if err != nil {
		return comments.ThreadRecord{}, missing(err)
	}
	return toThread(rec), nil
}

// Threads implements comments.Store. Filter values are bound parameters.
func (s *CommentStore) Threads(_ context.Context, repoID int64, f comments.ListFilter, limit int) ([]comments.ThreadRecord, error) {
	where := dbx.HashExp{"repo_id": repoID}
	if f.Path != "" {
		where["path"] = f.Path
	}
	if f.Status != "" {
		where["status"] = string(f.Status)
	}
	col, err := s.app.FindCollectionByNameOrId(ThreadsCollection)
	if err != nil {
		return nil, err
	}
	var recs []*core.Record
	err = s.app.RecordQuery(col).
		AndWhere(where).
		OrderBy("path ASC", "start_line ASC", "created_at ASC", "id ASC").
		Limit(int64(limit)).
		All(&recs)
	if err != nil {
		return nil, err
	}
	out := make([]comments.ThreadRecord, len(recs))
	for i, r := range recs {
		out[i] = toThread(r)
	}
	return out, nil
}

// Comments implements comments.Store.
func (s *CommentStore) Comments(_ context.Context, threadIDs []string) ([]comments.CommentRecord, error) {
	if len(threadIDs) == 0 {
		return nil, nil
	}
	vals := make([]any, len(threadIDs))
	for i, id := range threadIDs {
		vals[i] = id
	}
	col, err := s.app.FindCollectionByNameOrId(CommentsCollection)
	if err != nil {
		return nil, err
	}
	var recs []*core.Record
	err = s.app.RecordQuery(col).
		AndWhere(dbx.In("thread", vals...)).
		OrderBy("created_at ASC", "id ASC").
		All(&recs)
	if err != nil {
		return nil, err
	}
	out := make([]comments.CommentRecord, len(recs))
	for i, r := range recs {
		out[i] = toComment(r)
	}
	return out, nil
}

// Comment implements comments.Store.
func (s *CommentStore) Comment(_ context.Context, id string) (comments.CommentRecord, error) {
	rec, err := s.app.FindRecordById(CommentsCollection, id)
	if err != nil {
		return comments.CommentRecord{}, missing(err)
	}
	return toComment(rec), nil
}

// AddComment implements comments.Store.
func (s *CommentStore) AddComment(_ context.Context, c comments.CommentRecord) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		th, err := tx.FindRecordById(ThreadsCollection, c.ThreadID)
		if err != nil {
			return missing(err)
		}
		seq := th.GetInt("comment_seq") + 1
		if err := saveComment(tx, c, seq); err != nil {
			return err
		}
		th.Set("comment_seq", seq)
		th.Set("updated_at", c.CreatedAt)
		return tx.Save(th)
	})
}

// UpdateComment implements comments.Store.
func (s *CommentStore) UpdateComment(_ context.Context, c comments.CommentRecord) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		if _, err := tx.FindRecordById(CommentsCollection, c.ID); err != nil {
			return missing(err)
		}
		return saveComment(tx, c, 0)
	})
}

// DeleteComment implements comments.Store.
func (s *CommentStore) DeleteComment(_ context.Context, id string, at time.Time) (bool, error) {
	var threadDeleted bool
	err := s.app.RunInTransaction(func(tx core.App) error {
		rec, err := tx.FindRecordById(CommentsCollection, id)
		if err != nil {
			return missing(err)
		}
		threadID := rec.GetString("thread")
		if err := tx.Delete(rec); err != nil {
			return err
		}
		left, err := tx.CountRecords(CommentsCollection, dbx.HashExp{"thread": threadID})
		if err != nil {
			return err
		}
		th, err := tx.FindRecordById(ThreadsCollection, threadID)
		if err != nil {
			return missing(err)
		}
		if left == 0 {
			threadDeleted = true
			return tx.Delete(th) // cascades to read markers
		}
		th.Set("updated_at", at)
		return tx.Save(th)
	})
	return threadDeleted, err
}

// SetThreadStatus implements comments.Store. Write transactions are
// serialized by PocketBase, so the status check and update are atomic.
func (s *CommentStore) SetThreadStatus(_ context.Context, id string, from, to comments.Status, by comments.Actor, at time.Time) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		th, err := tx.FindRecordById(ThreadsCollection, id)
		if err != nil {
			return missing(err)
		}
		if comments.Status(th.GetString("status")) != from {
			return comments.ErrConflict
		}
		th.Set("status", string(to))
		th.Set("updated_at", at)
		if to == comments.StatusResolved {
			th.Set("resolved_by", by.UserID)
			th.Set("resolved_by_login", by.Login)
			th.Set("resolved_at", at)
		} else {
			th.Set("resolved_by", "")
			th.Set("resolved_by_login", "")
			th.Set("resolved_at", "")
		}
		return tx.Save(th)
	})
}

// MarkRead implements comments.Store. The marker records the thread's
// newest comment sequence number, so a comment saved later is unread even
// within the same millisecond.
func (s *CommentStore) MarkRead(_ context.Context, userID, threadID string, at time.Time) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		th, err := tx.FindRecordById(ThreadsCollection, threadID)
		if err != nil {
			return missing(err)
		}
		rec, err := tx.FindFirstRecordByFilter(ThreadReadsCollection, "user = {:user} && thread = {:thread}",
			dbx.Params{"user": userID, "thread": threadID})
		if errors.Is(err, sql.ErrNoRows) {
			col, cerr := tx.FindCollectionByNameOrId(ThreadReadsCollection)
			if cerr != nil {
				return cerr
			}
			rec = core.NewRecord(col)
			rec.Set("user", userID)
			rec.Set("thread", threadID)
		} else if err != nil {
			return err
		}
		rec.Set("last_read_seq", th.GetInt("comment_seq"))
		rec.Set("last_read", at)
		return tx.Save(rec)
	})
}

// UnreadCounts implements comments.Store, comparing comment sequence
// numbers with the read markers.
func (s *CommentStore) UnreadCounts(_ context.Context, userID string, repoID int64) (map[string]int, error) {
	var rows []struct {
		Thread string `db:"thread"`
		N      int    `db:"n"`
	}
	err := s.app.DB().NewQuery(`
		SELECT c.thread AS thread, COUNT(*) AS n
		FROM ` + CommentsCollection + ` c
		JOIN ` + ThreadsCollection + ` t ON t.id = c.thread
		LEFT JOIN ` + ThreadReadsCollection + ` r ON r.thread = c.thread AND r.user = {:user}
		WHERE t.repo_id = {:repo}
		  AND c.author_user != {:user}
		  AND c.seq > COALESCE(r.last_read_seq, 0)
		GROUP BY c.thread`).
		Bind(dbx.Params{"user": userID, "repo": repoID}).
		All(&rows)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int, len(rows))
	for _, r := range rows {
		out[r.Thread] = r.N
	}
	return out, nil
}

// saveComment creates the comment with sequence number seq, or updates its
// content when seq is 0.
func saveComment(tx core.App, c comments.CommentRecord, seq int) error {
	var rec *core.Record
	if seq > 0 {
		col, err := tx.FindCollectionByNameOrId(CommentsCollection)
		if err != nil {
			return err
		}
		rec = core.NewRecord(col)
		rec.Id = c.ID
		rec.Set("thread", c.ThreadID)
		rec.Set("author_kind", string(c.AuthorKind))
		rec.Set("author_user", c.AuthorUser)
		rec.Set("author_login", c.AuthorLogin)
		rec.Set("ai_client", c.AIClient)
		rec.Set("ai_model", c.AIModel)
		rec.Set("created_at", c.CreatedAt)
		rec.Set("seq", seq)
	} else {
		var err error
		if rec, err = tx.FindRecordById(CommentsCollection, c.ID); err != nil {
			return missing(err)
		}
	}
	rec.Set("body", c.Body)
	rec.Set("suggestion", c.Suggestion)
	rec.Set("suggestion_base_sha", c.SuggestionBaseSHA)
	setDate(rec, "edited_at", c.EditedAt)
	return tx.Save(rec)
}

func setThread(rec *core.Record, t comments.ThreadRecord) {
	rec.Set("repo_id", t.RepoID)
	rec.Set("repo_full_name", t.RepoFullName)
	rec.Set("path", t.Path)
	rec.Set("commit_sha", t.CommitSHA)
	rec.Set("start_line", t.Range.StartLine)
	rec.Set("end_line", t.Range.EndLine)
	rec.Set("start_column", t.Range.StartColumn)
	rec.Set("end_column", t.Range.EndColumn)
	rec.Set("quote_exact", t.QuoteExact)
	rec.Set("quote_prefix", t.QuotePrefix)
	rec.Set("quote_suffix", t.QuoteSuffix)
	rec.Set("anchor_sha", t.Position.CommitSHA)
	rec.Set("anchor_start_line", t.Position.Range.StartLine)
	rec.Set("anchor_end_line", t.Position.Range.EndLine)
	rec.Set("anchor_start_column", t.Position.Range.StartColumn)
	rec.Set("anchor_end_column", t.Position.Range.EndColumn)
	rec.Set("anchor_state", string(t.Position.State))
	rec.Set("origin", string(t.Origin))
	rec.Set("status", string(t.Status))
	rec.Set("created_by", t.CreatedBy)
	rec.Set("created_by_login", t.CreatedByLogin)
	rec.Set("created_at", t.CreatedAt)
	rec.Set("updated_at", t.UpdatedAt)
	rec.Set("resolved_by", t.ResolvedBy)
	rec.Set("resolved_by_login", t.ResolvedByLogin)
	setDate(rec, "resolved_at", t.ResolvedAt)
}

func toThread(rec *core.Record) comments.ThreadRecord {
	return comments.ThreadRecord{
		ID:           rec.Id,
		RepoID:       int64(rec.GetFloat("repo_id")),
		RepoFullName: rec.GetString("repo_full_name"),
		Path:         rec.GetString("path"),
		CommitSHA:    rec.GetString("commit_sha"),
		Range:        rangeOf(rec, ""),
		QuoteExact:   rec.GetString("quote_exact"),
		QuotePrefix:  rec.GetString("quote_prefix"),
		QuoteSuffix:  rec.GetString("quote_suffix"),
		Position: comments.Position{
			CommitSHA: rec.GetString("anchor_sha"),
			Range:     rangeOf(rec, "anchor_"),
			State:     comments.AnchorState(rec.GetString("anchor_state")),
		},
		Origin:          comments.Origin(rec.GetString("origin")),
		Status:          comments.Status(rec.GetString("status")),
		CreatedBy:       rec.GetString("created_by"),
		CreatedByLogin:  rec.GetString("created_by_login"),
		CreatedAt:       timeOf(rec, "created_at"),
		UpdatedAt:       timeOf(rec, "updated_at"),
		ResolvedBy:      rec.GetString("resolved_by"),
		ResolvedByLogin: rec.GetString("resolved_by_login"),
		ResolvedAt:      timeOf(rec, "resolved_at"),
	}
}

func toComment(rec *core.Record) comments.CommentRecord {
	return comments.CommentRecord{
		ID:                rec.Id,
		ThreadID:          rec.GetString("thread"),
		AuthorKind:        comments.AuthorKind(rec.GetString("author_kind")),
		AuthorUser:        rec.GetString("author_user"),
		AuthorLogin:       rec.GetString("author_login"),
		AIClient:          rec.GetString("ai_client"),
		AIModel:           rec.GetString("ai_model"),
		Body:              rec.GetString("body"),
		Suggestion:        rec.GetString("suggestion"),
		SuggestionBaseSHA: rec.GetString("suggestion_base_sha"),
		CreatedAt:         timeOf(rec, "created_at"),
		EditedAt:          timeOf(rec, "edited_at"),
	}
}

func rangeOf(rec *core.Record, prefix string) comments.Range {
	return comments.Range{
		StartLine:   rec.GetInt(prefix + "start_line"),
		EndLine:     rec.GetInt(prefix + "end_line"),
		StartColumn: rec.GetInt(prefix + "start_column"),
		EndColumn:   rec.GetInt(prefix + "end_column"),
	}
}

func setDate(rec *core.Record, field string, t time.Time) {
	if t.IsZero() {
		rec.Set(field, "")
		return
	}
	rec.Set(field, t)
}

// missing maps "no rows" to comments.ErrNotFound.
func missing(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return comments.ErrNotFound
	}
	return err
}
