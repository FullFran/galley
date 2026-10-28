package pbstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/FullFran/galley/server/internal/admin"
	"github.com/FullFran/galley/server/internal/comments"
)

// AdminStore implements admin.Store. It never reads draft content.
type AdminStore struct {
	app core.App
}

var _ admin.Store = (*AdminStore)(nil)

// NewAdminStore returns an AdminStore backed by app.
func NewAdminStore(app core.App) *AdminStore {
	return &AdminStore{app: app}
}

// TouchActivity implements admin.Store.
func (s *AdminStore) TouchActivity(_ context.Context, a admin.Activity) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		rec, err := tx.FindFirstRecordByFilter(RepoActivityCollection, "user = {:user} && repo_id = {:repo}",
			dbx.Params{"user": a.UserID, "repo": a.RepoID})
		switch {
		case errors.Is(err, sql.ErrNoRows):
			col, cerr := tx.FindCollectionByNameOrId(RepoActivityCollection)
			if cerr != nil {
				return cerr
			}
			rec = core.NewRecord(col)
			rec.Set("user", a.UserID)
			rec.Set("repo_id", a.RepoID)
			rec.Set("first_seen", a.FirstSeen.UTC())
		case err != nil:
			return err
		}
		rec.Set("permission", string(a.Level))
		rec.Set("last_seen", a.LastSeen.UTC())
		return tx.Save(rec)
	})
}

// HasActivity implements admin.Store.
func (s *AdminStore) HasActivity(_ context.Context, userID string, repoID int64, since time.Time) (bool, error) {
	at, err := types.ParseDateTime(since.UTC())
	if err != nil {
		return false, err
	}
	var n int
	err = s.app.DB().Select("COUNT(*)").From(RepoActivityCollection).
		Where(dbx.And(dbx.HashExp{"user": userID, "repo_id": repoID},
			dbx.NewExp("last_seen >= {:since}", dbx.Params{"since": at.String()}))).Row(&n)
	return n > 0, err
}

// People implements admin.Store.
func (s *AdminStore) People(_ context.Context, repoID int64, limit int) ([]admin.Person, error) {
	var rows []struct {
		User      string         `db:"user"`
		Login     string         `db:"login"`
		GitHubID  int64          `db:"github_id"`
		Level     string         `db:"permission"`
		FirstSeen types.DateTime `db:"first_seen"`
		LastSeen  types.DateTime `db:"last_seen"`
	}
	err := s.app.DB().Select("a.user AS user", "u.login AS login", "u.github_id AS github_id", "a.permission AS permission",
		"a.first_seen AS first_seen", "a.last_seen AS last_seen").
		From(RepoActivityCollection+" a").
		InnerJoin(UsersCollection+" u", dbx.NewExp("u.id = a.user")).
		Where(dbx.HashExp{"a.repo_id": repoID}).
		OrderBy("a.last_seen DESC", "u.login ASC").
		Limit(int64(limit)).
		All(&rows)
	if err != nil {
		return nil, err
	}
	out := make([]admin.Person, len(rows))
	for i, r := range rows {
		out[i] = admin.Person{
			Activity: admin.Activity{UserID: r.User, RepoID: repoID, Level: admin.Level(r.Level),
				FirstSeen: r.FirstSeen.Time(), LastSeen: r.LastSeen.Time()},
			Login: r.Login, GitHubID: r.GitHubID,
		}
	}
	return out, nil
}

// DraftStats implements admin.Store. The content column is never selected.
func (s *AdminStore) DraftStats(_ context.Context, repoID int64) (map[string]admin.DraftStats, error) {
	var rows []struct {
		Owner  string         `db:"owner"`
		Count  int            `db:"n"`
		Bytes  int64          `db:"bytes"`
		Oldest types.DateTime `db:"oldest"`
		Newest types.DateTime `db:"newest"`
	}
	err := s.app.DB().Select("owner", "COUNT(*) AS n", "COALESCE(SUM(size), 0) AS bytes",
		"MIN(updated_at) AS oldest", "MAX(updated_at) AS newest").
		From(DraftsCollection).
		Where(dbx.HashExp{"repo_id": repoID}).
		GroupBy("owner").
		All(&rows)
	if err != nil {
		return nil, err
	}
	out := make(map[string]admin.DraftStats, len(rows))
	for _, r := range rows {
		out[r.Owner] = admin.DraftStats{Count: r.Count, Bytes: r.Bytes, Oldest: r.Oldest.Time(), Newest: r.Newest.Time()}
	}
	return out, nil
}

// Allowlist implements admin.Store.
func (s *AdminStore) Allowlist(_ context.Context, repoID int64, limit int) ([]admin.AllowEntry, error) {
	recs, err := s.app.FindRecordsByFilter(RepoAllowlistCollection, "repo_id = {:repo}", "created_at", limit, 0,
		dbx.Params{"repo": repoID})
	if err != nil {
		return nil, err
	}
	out := make([]admin.AllowEntry, len(recs))
	for i, r := range recs {
		out[i] = admin.AllowEntry{ID: r.Id, RepoID: repoID, GitHubID: int64(r.GetFloat("github_id")),
			Login: r.GetString("login"), AddedBy: r.GetString("added_by"), CreatedAt: timeOf(r, "created_at")}
	}
	return out, nil
}

// AddAllowEntry implements admin.Store. PocketBase serializes write
// transactions, so the cap, the duplicate check, the insert and the audit
// row are atomic.
func (s *AdminStore) AddAllowEntry(_ context.Context, e admin.AllowEntry, max int, audit admin.AuditEntry) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		var rows []struct {
			GitHubID int64  `db:"github_id"`
			Login    string `db:"login"`
		}
		err := tx.DB().Select("github_id", "login").From(RepoAllowlistCollection).
			Where(dbx.HashExp{"repo_id": e.RepoID}).All(&rows)
		if err != nil {
			return err
		}
		for _, x := range rows {
			if (e.GitHubID != 0 && x.GitHubID == e.GitHubID) || (e.GitHubID == 0 && x.GitHubID == 0 && x.Login == e.Login) {
				return comments.ErrConflict
			}
		}
		if len(rows) >= max {
			return admin.ErrAllowlistFull
		}
		col, err := tx.FindCollectionByNameOrId(RepoAllowlistCollection)
		if err != nil {
			return err
		}
		rec := core.NewRecord(col)
		rec.Id = e.ID
		rec.Set("repo_id", e.RepoID)
		rec.Set("github_id", e.GitHubID)
		rec.Set("login", e.Login)
		rec.Set("added_by", e.AddedBy)
		rec.Set("created_at", e.CreatedAt.UTC())
		if err := tx.Save(rec); err != nil {
			return err
		}
		return appendAudit(tx, audit)
	})
}

// DeleteAllowEntry implements admin.Store.
func (s *AdminStore) DeleteAllowEntry(_ context.Context, repoID int64, id string, audit admin.AuditEntry) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		rec, err := tx.FindFirstRecordByFilter(RepoAllowlistCollection, "id = {:id} && repo_id = {:repo}",
			dbx.Params{"id": id, "repo": repoID})
		if errors.Is(err, sql.ErrNoRows) {
			return comments.ErrNotFound
		}
		if err != nil {
			return err
		}
		if err := tx.Delete(rec); err != nil {
			return err
		}
		return appendAudit(tx, audit)
	})
}

// CreateShare implements admin.Store.
func (s *AdminStore) CreateShare(_ context.Context, sh admin.Share, audit admin.AuditEntry) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		col, err := tx.FindCollectionByNameOrId(DraftSharesCollection)
		if err != nil {
			return err
		}
		rec := core.NewRecord(col)
		rec.Id = sh.ID
		rec.Set("draft", sh.DraftID)
		rec.Set("owner", sh.Owner)
		rec.Set("repo_id", sh.RepoID)
		rec.Set("path", sh.Path)
		rec.Set("created_at", sh.CreatedAt.UTC())
		rec.Set("expires_at", sh.ExpiresAt.UTC())
		if err := tx.Save(rec); err != nil {
			return err
		}
		return appendAudit(tx, audit)
	})
}

// ExtendShare implements admin.Store. The active check is inside the write
// transaction, so a grant revoked meanwhile is never revived.
func (s *AdminStore) ExtendShare(_ context.Context, id string, now, expiresAt time.Time, audit admin.AuditEntry) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		rec, err := tx.FindFirstRecordByFilter(DraftSharesCollection, "id = {:id} && revoked_at = ''", dbx.Params{"id": id})
		if errors.Is(err, sql.ErrNoRows) {
			return comments.ErrNotFound
		}
		if err != nil {
			return err
		}
		if !now.Before(timeOf(rec, "expires_at")) {
			return comments.ErrNotFound
		}
		rec.Set("expires_at", expiresAt.UTC())
		if err := tx.Save(rec); err != nil {
			return err
		}
		return appendAudit(tx, audit)
	})
}

type shareRow struct {
	ID         string         `db:"id"`
	Draft      string         `db:"draft"`
	Owner      string         `db:"owner"`
	OwnerLogin string         `db:"owner_login"`
	RepoID     int64          `db:"repo_id"`
	Path       string         `db:"path"`
	CreatedAt  types.DateTime `db:"created_at"`
	ExpiresAt  types.DateTime `db:"expires_at"`
	RevokedAt  types.DateTime `db:"revoked_at"`
}

func (r shareRow) share() admin.Share {
	sh := admin.Share{ID: r.ID, DraftID: r.Draft, Owner: r.Owner, OwnerLogin: r.OwnerLogin, RepoID: r.RepoID, Path: r.Path,
		CreatedAt: r.CreatedAt.Time(), ExpiresAt: r.ExpiresAt.Time()}
	if !r.RevokedAt.IsZero() {
		sh.RevokedAt = r.RevokedAt.Time()
	}
	return sh
}

func (s *AdminStore) shareQuery() *dbx.SelectQuery {
	return s.app.DB().Select("s.id AS id", "s.draft AS draft", "s.owner AS owner", "u.login AS owner_login",
		"s.repo_id AS repo_id", "s.path AS path", "s.created_at AS created_at", "s.expires_at AS expires_at",
		"s.revoked_at AS revoked_at").
		From(DraftSharesCollection+" s").
		InnerJoin(UsersCollection+" u", dbx.NewExp("u.id = s.owner"))
}

// activeShareQuery also drops grants whose draft no longer exists.
func (s *AdminStore) activeShareQuery() *dbx.SelectQuery {
	return s.shareQuery().InnerJoin(DraftsCollection+" d", dbx.NewExp("d.id = s.draft"))
}

// Share implements admin.Store.
func (s *AdminStore) Share(_ context.Context, id string) (admin.Share, error) {
	var r shareRow
	err := s.shareQuery().Where(dbx.HashExp{"s.id": id}).One(&r)
	if errors.Is(err, sql.ErrNoRows) {
		return admin.Share{}, comments.ErrNotFound
	}
	if err != nil {
		return admin.Share{}, err
	}
	return r.share(), nil
}

// ActiveShares implements admin.Store.
func (s *AdminStore) ActiveShares(_ context.Context, repoID int64, owner string, now time.Time, limit int) ([]admin.Share, error) {
	at, err := types.ParseDateTime(now.UTC())
	if err != nil {
		return nil, err
	}
	where := dbx.And(
		dbx.HashExp{"s.repo_id": repoID, "s.revoked_at": ""},
		dbx.NewExp("s.expires_at > {:now}", dbx.Params{"now": at.String()}),
	)
	if owner != "" {
		where = dbx.And(where, dbx.HashExp{"s.owner": owner})
	}
	var rows []shareRow
	if err := s.activeShareQuery().Where(where).OrderBy("s.created_at DESC", "s.id DESC").Limit(int64(limit)).All(&rows); err != nil {
		return nil, err
	}
	out := make([]admin.Share, len(rows))
	for i, r := range rows {
		out[i] = r.share()
	}
	return out, nil
}

// RevokeShares implements admin.Store.
func (s *AdminStore) RevokeShares(_ context.Context, owner string, repoID int64, path string, now time.Time, audit admin.AuditEntry) ([]string, error) {
	var ids []string
	err := s.app.RunInTransaction(func(tx core.App) error {
		ids = nil
		recs, err := tx.FindAllRecords(DraftSharesCollection, dbx.HashExp{"owner": owner, "repo_id": repoID, "path": path, "revoked_at": ""})
		if err != nil {
			return err
		}
		for _, rec := range recs {
			if !now.Before(timeOf(rec, "expires_at")) {
				continue
			}
			rec.Set("revoked_at", now.UTC())
			if err := tx.Save(rec); err != nil {
				return err
			}
			ids = append(ids, rec.Id)
			e := audit
			e.ID, e.Target = "", "share:"+rec.Id
			if err := appendAudit(tx, e); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return ids, nil
}

// AppendAudit implements admin.Store.
func (s *AdminStore) AppendAudit(_ context.Context, e admin.AuditEntry) error {
	return appendAudit(s.app, e)
}

// appendAudit writes e with app (a transaction or the app); an empty id is
// generated.
func appendAudit(app core.App, e admin.AuditEntry) error {
	col, err := app.FindCollectionByNameOrId(AuditCollection)
	if err != nil {
		return err
	}
	rec := core.NewRecord(col)
	if e.ID != "" {
		rec.Id = e.ID
	}
	rec.Set("repo_id", e.RepoID)
	rec.Set("actor", e.ActorID)
	rec.Set("actor_login", e.ActorLogin)
	rec.Set("action", e.Action)
	rec.Set("target", e.Target)
	rec.Set("at", e.At.UTC())
	return app.Save(rec)
}

// Audit implements admin.Store. Entries written in the same millisecond keep
// their insertion order (rowid).
func (s *AdminStore) Audit(_ context.Context, repoID int64, limit int) ([]admin.AuditEntry, error) {
	var rows []struct {
		ID         string         `db:"id"`
		Actor      string         `db:"actor"`
		ActorLogin string         `db:"actor_login"`
		Action     string         `db:"action"`
		Target     string         `db:"target"`
		At         types.DateTime `db:"at"`
	}
	err := s.app.DB().Select("id", "actor", "actor_login", "action", "target", "at").
		From(AuditCollection).
		Where(dbx.HashExp{"repo_id": repoID}).
		OrderBy("at DESC", "rowid DESC").
		Limit(int64(limit)).
		All(&rows)
	if err != nil {
		return nil, err
	}
	out := make([]admin.AuditEntry, len(rows))
	for i, r := range rows {
		out[i] = admin.AuditEntry{ID: r.ID, RepoID: repoID, ActorID: r.Actor, ActorLogin: r.ActorLogin, Action: r.Action,
			Target: r.Target, At: r.At.Time()}
	}
	return out, nil
}
