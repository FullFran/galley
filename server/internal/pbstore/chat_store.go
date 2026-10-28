package pbstore

import (
	"context"
	"database/sql"
	"errors"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/FullFran/galley/server/internal/chat"
)

// ChatStore implements chat.Store. It only sees sealed bodies.
type ChatStore struct {
	app core.App
}

var _ chat.Store = (*ChatStore)(nil)

// NewChatStore returns a ChatStore backed by app.
func NewChatStore(app core.App) *ChatStore {
	return &ChatStore{app: app}
}

// Append implements chat.Store. PocketBase serializes write transactions, so
// reading the newest seq and inserting the next one is atomic; the unique
// (repo_id, seq) index backs it.
func (s *ChatStore) Append(_ context.Context, r chat.Record) (int64, error) {
	var seq int64
	err := s.app.RunInTransaction(func(tx core.App) error {
		latest, err := latestSeq(tx, r.RepoID)
		if err != nil {
			return err
		}
		col, err := tx.FindCollectionByNameOrId(ChatMessagesCollection)
		if err != nil {
			return err
		}
		seq = latest + 1
		rec := core.NewRecord(col)
		rec.Id = r.ID
		rec.Set("repo_id", r.RepoID)
		rec.Set("seq", seq)
		rec.Set("author", r.Author)
		rec.Set("author_login", r.AuthorLogin)
		rec.Set("body", r.Body)
		rec.Set("created_at", r.CreatedAt)
		return tx.Save(rec)
	})
	return seq, err
}

// Before implements chat.Store.
func (s *ChatStore) Before(_ context.Context, repoID, beforeSeq int64, limit int) ([]chat.Record, error) {
	q := s.query().AndWhere(dbx.HashExp{"repo_id": repoID})
	if beforeSeq > 0 {
		q = q.AndWhere(dbx.NewExp("seq < {:before}", dbx.Params{"before": beforeSeq}))
	}
	return s.messages(q.OrderBy("seq DESC").Limit(int64(limit)))
}

// After implements chat.Store.
func (s *ChatStore) After(_ context.Context, repoID, afterSeq int64, limit int) ([]chat.Record, error) {
	q := s.query().
		AndWhere(dbx.HashExp{"repo_id": repoID}).
		AndWhere(dbx.NewExp("seq > {:after}", dbx.Params{"after": afterSeq}))
	return s.messages(q.OrderBy("seq ASC").Limit(int64(limit)))
}

// MarkRead implements chat.Store.
func (s *ChatStore) MarkRead(_ context.Context, userID string, repoID, seq int64) (int64, error) {
	var stored int64
	err := s.app.RunInTransaction(func(tx core.App) error {
		latest, err := latestSeq(tx, repoID)
		if err != nil {
			return err
		}
		if seq <= 0 || seq > latest {
			seq = latest
		}
		rec, err := tx.FindFirstRecordByFilter(ChatReadsCollection, "user = {:user} && repo_id = {:repo}",
			dbx.Params{"user": userID, "repo": repoID})
		if errors.Is(err, sql.ErrNoRows) {
			col, cerr := tx.FindCollectionByNameOrId(ChatReadsCollection)
			if cerr != nil {
				return cerr
			}
			rec = core.NewRecord(col)
			rec.Set("user", userID)
			rec.Set("repo_id", repoID)
		} else if err != nil {
			return err
		}
		stored = max(int64(rec.GetInt("last_read_seq")), seq)
		rec.Set("last_read_seq", stored)
		return tx.Save(rec)
	})
	return stored, err
}

// Unread implements chat.Store.
func (s *ChatStore) Unread(_ context.Context, userID string, repoID int64) (chat.Unread, error) {
	var row struct {
		Count    int   `db:"n"`
		LastRead int64 `db:"last_read"`
		Latest   int64 `db:"latest"`
	}
	err := s.app.DB().NewQuery(`
		SELECT
		  (SELECT COUNT(*) FROM ` + ChatMessagesCollection + ` m
		    WHERE m.repo_id = {:repo} AND m.author != {:user}
		      AND m.seq > COALESCE((SELECT last_read_seq FROM ` + ChatReadsCollection + `
		                            WHERE user = {:user} AND repo_id = {:repo}), 0)) AS n,
		  COALESCE((SELECT last_read_seq FROM ` + ChatReadsCollection + `
		            WHERE user = {:user} AND repo_id = {:repo}), 0) AS last_read,
		  COALESCE((SELECT MAX(seq) FROM ` + ChatMessagesCollection + ` WHERE repo_id = {:repo}), 0) AS latest`).
		Bind(dbx.Params{"user": userID, "repo": repoID}).
		One(&row)
	if err != nil {
		return chat.Unread{}, err
	}
	return chat.Unread{RepoID: repoID, Count: row.Count, LastReadSeq: row.LastRead, LatestSeq: row.Latest}, nil
}

func (s *ChatStore) query() *dbx.SelectQuery {
	return s.app.RecordQuery(ChatMessagesCollection)
}

func (s *ChatStore) messages(q *dbx.SelectQuery) ([]chat.Record, error) {
	var recs []*core.Record
	if err := q.All(&recs); err != nil {
		return nil, err
	}
	out := make([]chat.Record, len(recs))
	for i, r := range recs {
		out[i] = chat.Record{
			ID:          r.Id,
			RepoID:      int64(r.GetFloat("repo_id")),
			Seq:         int64(r.GetInt("seq")),
			Author:      r.GetString("author"),
			AuthorLogin: r.GetString("author_login"),
			Body:        r.GetString("body"),
			CreatedAt:   timeOf(r, "created_at"),
		}
	}
	return out, nil
}

func latestSeq(app core.App, repoID int64) (int64, error) {
	var row struct {
		Latest int64 `db:"latest"`
	}
	err := app.DB().NewQuery(`SELECT COALESCE(MAX(seq), 0) AS latest FROM ` + ChatMessagesCollection + ` WHERE repo_id = {:repo}`).
		Bind(dbx.Params{"repo": repoID}).
		One(&row)
	return row.Latest, err
}
