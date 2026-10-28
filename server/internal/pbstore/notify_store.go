package pbstore

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/notify"
)

// Notification collection names.
const (
	NotifyPrefsCollection  = "galley_notify_prefs"
	NotifyOutboxCollection = "galley_notify_outbox"
)

// Every API rule stays nil (superusers only); the sealed address is hidden
// too. The outbox only holds idempotency key hashes, never addresses.
func init() {
	core.AppMigrations.Register(createNotifyCollections,
		dropCollections(NotifyOutboxCollection, NotifyPrefsCollection),
		"1793534400_galley_notify.go")
}

func createNotifyCollections(app core.App) error {
	users, err := app.FindCollectionByNameOrId(UsersCollection)
	if err != nil {
		return err
	}
	prefs := core.NewBaseCollection(NotifyPrefsCollection)
	prefs.Fields.Add(
		&core.RelationField{Name: "user", Required: true, CollectionId: users.Id, MaxSelect: 1, CascadeDelete: true},
		&core.TextField{Name: "email", Required: true, Hidden: true, Max: 1024},
		&core.BoolField{Name: "verified"},
		&core.BoolField{Name: "enabled"},
		&core.TextField{Name: "kinds", Max: 200, Pattern: `^[a-z_,]*$`},
		&core.DateField{Name: "updated_at", Required: true},
	)
	prefs.AddIndex("idx_galley_notify_prefs_user", true, "user", "")
	if err := app.Save(prefs); err != nil {
		return err
	}
	outbox := core.NewBaseCollection(NotifyOutboxCollection)
	outbox.Fields.Add(
		&core.TextField{Name: "key", Required: true, Min: 64, Max: 64, Pattern: `^[0-9a-f]{64}$`},
		&core.DateField{Name: "created_at", Required: true},
	)
	outbox.AddIndex("idx_galley_notify_outbox_key", true, "key", "")
	outbox.AddIndex("idx_galley_notify_outbox_created", false, "created_at", "")
	return app.Save(outbox)
}

// NotifyStore implements notify.Store and notify.Users.
type NotifyStore struct{ app core.App }

var (
	_ notify.Store = (*NotifyStore)(nil)
	_ notify.Users = (*NotifyStore)(nil)
)

// NewNotifyStore returns a NotifyStore backed by app.
func NewNotifyStore(app core.App) *NotifyStore { return &NotifyStore{app: app} }

// UserIDByGitHubID implements notify.Users through the unique github_id
// index.
func (s *NotifyStore) UserIDByGitHubID(_ context.Context, githubID int64) (string, error) {
	rec, err := s.app.FindFirstRecordByData(UsersCollection, "github_id", githubID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", comments.ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return rec.Id, nil
}

// Prefs implements notify.Store.
func (s *NotifyStore) Prefs(_ context.Context, userID string) (notify.Prefs, error) {
	rec, err := s.app.FindFirstRecordByData(NotifyPrefsCollection, "user", userID)
	if errors.Is(err, sql.ErrNoRows) {
		return notify.Prefs{}, comments.ErrNotFound
	}
	if err != nil {
		return notify.Prefs{}, err
	}
	p := notify.Prefs{
		UserID:    userID,
		Email:     rec.GetString("email"),
		Verified:  rec.GetBool("verified"),
		Enabled:   rec.GetBool("enabled"),
		Kinds:     []notify.Kind{},
		UpdatedAt: rec.GetDateTime("updated_at").Time(),
	}
	for _, k := range strings.Split(rec.GetString("kinds"), ",") {
		if k != "" {
			p.Kinds = append(p.Kinds, notify.Kind(k))
		}
	}
	return p, nil
}

// SavePrefs implements notify.Store (insert or update by user).
func (s *NotifyStore) SavePrefs(_ context.Context, p notify.Prefs) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		rec, err := tx.FindFirstRecordByData(NotifyPrefsCollection, "user", p.UserID)
		if errors.Is(err, sql.ErrNoRows) {
			col, cerr := tx.FindCollectionByNameOrId(NotifyPrefsCollection)
			if cerr != nil {
				return cerr
			}
			rec = core.NewRecord(col)
			rec.Set("user", p.UserID)
		} else if err != nil {
			return err
		}
		kinds := make([]string, len(p.Kinds))
		for i, k := range p.Kinds {
			kinds[i] = string(k)
		}
		rec.Set("email", p.Email)
		rec.Set("verified", p.Verified)
		rec.Set("enabled", p.Enabled)
		rec.Set("kinds", strings.Join(kinds, ","))
		rec.Set("updated_at", p.UpdatedAt)
		return tx.Save(rec)
	})
}

// DeletePrefs implements notify.Store.
func (s *NotifyStore) DeletePrefs(_ context.Context, userID string) error {
	return s.deleteAll(NotifyPrefsCollection, dbx.HashExp{"user": userID})
}

// Reserve implements notify.Store. PocketBase serializes write
// transactions and the key index is unique, so two reservations of one key
// cannot both succeed.
func (s *NotifyStore) Reserve(_ context.Context, key string, at time.Time) (bool, error) {
	fresh := false
	err := s.app.RunInTransaction(func(tx core.App) error {
		if _, err := tx.FindFirstRecordByData(NotifyOutboxCollection, "key", key); err == nil {
			return nil
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		col, err := tx.FindCollectionByNameOrId(NotifyOutboxCollection)
		if err != nil {
			return err
		}
		rec := core.NewRecord(col)
		rec.Set("key", key)
		rec.Set("created_at", at)
		if err := tx.Save(rec); err != nil {
			return err
		}
		fresh = true
		return nil
	})
	return fresh, err
}

// Release implements notify.Store.
func (s *NotifyStore) Release(_ context.Context, key string) error {
	return s.deleteAll(NotifyOutboxCollection, dbx.HashExp{"key": key})
}

// PurgeReservations implements notify.Store.
func (s *NotifyStore) PurgeReservations(_ context.Context, before time.Time) (int, error) {
	dt, err := types.ParseDateTime(before.UTC())
	if err != nil {
		return 0, err
	}
	// The outbox has no dependents, so a raw delete is safe.
	res, err := s.app.DB().Delete(NotifyOutboxCollection, dbx.NewExp("created_at < {:before}", dbx.Params{"before": dt.String()})).Execute()
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

func (s *NotifyStore) deleteAll(collection string, where dbx.Expression) error {
	return (&Store{app: s.app}).deleteWhere(collection, where)
}
