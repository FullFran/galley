package pbstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/drafts"
)

// DraftStore implements drafts.Store. It only sees sealed content.
type DraftStore struct {
	app core.App
}

var _ drafts.Store = (*DraftStore)(nil)

// NewDraftStore returns a DraftStore backed by app.
func NewDraftStore(app core.App) *DraftStore {
	return &DraftStore{app: app}
}

const draftWhere = "owner = {:owner} && repo_id = {:repo} && path = {:path}"

// Draft implements drafts.Store.
func (s *DraftStore) Draft(_ context.Context, owner string, repoID int64, path string) (drafts.Record, error) {
	rec, err := findDraft(s.app, owner, repoID, path)
	if err != nil {
		return drafts.Record{}, err
	}
	return toDraft(rec), nil
}

// Drafts implements drafts.Store. The content column is not selected.
func (s *DraftStore) Drafts(_ context.Context, owner string, repoID int64, limit int) ([]drafts.Record, error) {
	var rows []struct {
		ID        string         `db:"id"`
		Path      string         `db:"path"`
		BaseSHA   string         `db:"base_sha"`
		BaseRef   string         `db:"base_ref"`
		Device    string         `db:"device"`
		Size      int            `db:"size"`
		Version   string         `db:"version"`
		UpdatedAt types.DateTime `db:"updated_at"`
	}
	err := s.app.DB().Select("id", "path", "base_sha", "base_ref", "device", "size", "version", "updated_at").
		From(DraftsCollection).
		Where(dbx.HashExp{"owner": owner, "repo_id": repoID}).
		OrderBy("updated_at DESC", "path ASC").
		Limit(int64(limit)).
		All(&rows)
	if err != nil {
		return nil, err
	}
	out := make([]drafts.Record, len(rows))
	for i, r := range rows {
		out[i] = drafts.Record{
			ID: r.ID, Owner: owner, RepoID: repoID, Path: r.Path, BaseSHA: r.BaseSHA, BaseRef: r.BaseRef,
			Device: r.Device, Size: r.Size, Version: r.Version, UpdatedAt: r.UpdatedAt.Time(),
		}
	}
	return out, nil
}

// Put implements drafts.Store. PocketBase serializes write transactions, so
// the guard, the precondition, the limits and the write are atomic; the
// unique index on (owner, repo_id, path) backs the create case.
func (s *DraftStore) Put(_ context.Context, r drafts.Record, pre drafts.Precondition, lim drafts.Limits, guard func() error) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		if guard != nil {
			if err := guard(); err != nil {
				return err
			}
		}
		rec, err := findDraft(tx, r.Owner, r.RepoID, r.Path)
		creating := errors.Is(err, comments.ErrNotFound)
		switch {
		case creating:
			if !pre.At.IsZero() {
				return comments.ErrConflict
			}
		case err != nil:
			return err
		default:
			at := rec.GetDateTime("updated_at").Time().Truncate(time.Millisecond)
			if pre.At.IsZero() || rec.Id != r.ID || !at.Equal(pre.At.Truncate(time.Millisecond)) ||
				(pre.Version != "" && pre.Version != rec.GetString("version")) {
				return comments.ErrConflict
			}
		}
		if err := checkLimits(tx, r, lim, creating); err != nil {
			return err
		}
		if creating {
			col, err := tx.FindCollectionByNameOrId(DraftsCollection)
			if err != nil {
				return err
			}
			rec = core.NewRecord(col)
			rec.Id = r.ID
			rec.Set("owner", r.Owner)
			rec.Set("repo_id", r.RepoID)
			rec.Set("path", r.Path)
		}
		rec.Set("base_sha", r.BaseSHA)
		rec.Set("base_ref", r.BaseRef)
		rec.Set("device", r.Device)
		rec.Set("size", r.Size)
		rec.Set("content", r.Content)
		rec.Set("version", r.Version)
		rec.Set("updated_at", r.UpdatedAt)
		return tx.Save(rec)
	})
}

// checkLimits counts the owner's other drafts: per repository and in total,
// and their total size plus the new one.
func checkLimits(tx core.App, r drafts.Record, lim drafts.Limits, creating bool) error {
	var row struct {
		InRepo int   `db:"in_repo"`
		Total  int   `db:"total"`
		Bytes  int64 `db:"bytes"`
	}
	err := tx.DB().NewQuery(`
		SELECT
		  COALESCE(SUM(CASE WHEN repo_id = {:repo} THEN 1 ELSE 0 END), 0) AS in_repo,
		  COUNT(*) AS total,
		  COALESCE(SUM(size), 0) AS bytes
		FROM ` + DraftsCollection + `
		WHERE owner = {:owner} AND id != {:id}`).
		Bind(dbx.Params{"owner": r.Owner, "repo": r.RepoID, "id": r.ID}).
		One(&row)
	if err != nil {
		return err
	}
	switch {
	case creating && row.InRepo >= lim.MaxDrafts:
		return drafts.ErrLimit
	case creating && row.Total >= lim.MaxOwnerDrafts:
		return drafts.ErrOwnerDrafts
	case row.Bytes+int64(r.Size) > lim.MaxOwnerBytes:
		return drafts.ErrOwnerStorage
	}
	return nil
}

// Delete implements drafts.Store.
func (s *DraftStore) Delete(_ context.Context, owner string, repoID int64, path string) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		rec, err := findDraft(tx, owner, repoID, path)
		if err != nil {
			return err
		}
		return tx.Delete(rec)
	})
}

// DeleteRepo implements drafts.Store.
func (s *DraftStore) DeleteRepo(_ context.Context, owner string, repoID int64) (int, error) {
	return s.deleteWhere(dbx.HashExp{"owner": owner, "repo_id": repoID})
}

// DeleteOwner implements drafts.Store.
func (s *DraftStore) DeleteOwner(_ context.Context, owner string) (int, error) {
	return s.deleteWhere(dbx.HashExp{"owner": owner})
}

// DeleteIdle implements drafts.Store.
func (s *DraftStore) DeleteIdle(_ context.Context, before time.Time) (int, error) {
	dt, err := types.ParseDateTime(before.UTC())
	if err != nil {
		return 0, err
	}
	return s.deleteWhere(dbx.NewExp("updated_at < {:before}", dbx.Params{"before": dt.String()}))
}

// deleteWhere deletes in one statement: drafts have no dependent records and
// no hooks, so going through the record API one by one buys nothing.
func (s *DraftStore) deleteWhere(where dbx.Expression) (int, error) {
	res, err := s.app.NonconcurrentDB().Delete(DraftsCollection, where).Execute()
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

func findDraft(app core.App, owner string, repoID int64, path string) (*core.Record, error) {
	rec, err := app.FindFirstRecordByFilter(DraftsCollection, draftWhere,
		dbx.Params{"owner": owner, "repo": repoID, "path": path})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, comments.ErrNotFound
	}
	return rec, err
}

func toDraft(rec *core.Record) drafts.Record {
	return drafts.Record{
		ID:        rec.Id,
		Owner:     rec.GetString("owner"),
		RepoID:    int64(rec.GetFloat("repo_id")),
		Path:      rec.GetString("path"),
		BaseSHA:   rec.GetString("base_sha"),
		BaseRef:   rec.GetString("base_ref"),
		Device:    rec.GetString("device"),
		Size:      rec.GetInt("size"),
		Content:   rec.GetString("content"),
		Version:   rec.GetString("version"),
		UpdatedAt: timeOf(rec, "updated_at"),
	}
}
