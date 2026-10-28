// Package pbstore implements galley's auth stores on PocketBase collections.
// Importing it registers the collection migrations.
package pbstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/FullFran/galley/server/internal/auth"
)

// Store implements auth.UserTokenStore and auth.SessionStore.
type Store struct {
	app core.App
}

var (
	_ auth.UserTokenStore = (*Store)(nil)
	_ auth.SessionStore   = (*Store)(nil)
)

// New returns a Store backed by app.
func New(app core.App) *Store {
	return &Store{app: app}
}

// UpsertUser implements auth.UserTokenStore.
func (s *Store) UpsertUser(_ context.Context, u auth.GitHubUser) (auth.User, error) {
	rec, err := s.app.FindFirstRecordByData(UsersCollection, "github_id", u.ID)
	if errors.Is(err, sql.ErrNoRows) {
		col, cerr := s.app.FindCollectionByNameOrId(UsersCollection)
		if cerr != nil {
			return auth.User{}, cerr
		}
		rec = core.NewRecord(col)
		rec.Set("github_id", u.ID)
	} else if err != nil {
		return auth.User{}, err
	}
	rec.Set("login", u.Login)
	if err := s.app.Save(rec); err != nil {
		return auth.User{}, err
	}
	return toUser(rec), nil
}

// UserByGitHubID implements auth.UserTokenStore.
func (s *Store) UserByGitHubID(_ context.Context, githubID int64) (auth.User, error) {
	rec, err := s.app.FindFirstRecordByData(UsersCollection, "github_id", githubID)
	if err != nil {
		return auth.User{}, notFound(err)
	}
	return toUser(rec), nil
}

// UserByID implements auth.UserTokenStore.
func (s *Store) UserByID(_ context.Context, id string) (auth.User, error) {
	rec, err := s.app.FindRecordById(UsersCollection, id)
	if err != nil {
		return auth.User{}, notFound(err)
	}
	return toUser(rec), nil
}

// SaveRefreshToken implements auth.UserTokenStore.
func (s *Store) SaveRefreshToken(_ context.Context, userID string, t auth.StoredToken) error {
	rec, err := s.app.FindFirstRecordByData(TokensCollection, "user", userID)
	if errors.Is(err, sql.ErrNoRows) {
		col, cerr := s.app.FindCollectionByNameOrId(TokensCollection)
		if cerr != nil {
			return cerr
		}
		rec = core.NewRecord(col)
		rec.Set("user", userID)
	} else if err != nil {
		return err
	}
	rec.Set("refresh_ciphertext", t.Ciphertext)
	if t.ExpiresAt.IsZero() {
		rec.Set("expires_at", "")
	} else {
		rec.Set("expires_at", t.ExpiresAt)
	}
	return s.app.Save(rec)
}

// LoadRefreshToken implements auth.UserTokenStore.
func (s *Store) LoadRefreshToken(_ context.Context, userID string) (auth.StoredToken, error) {
	rec, err := s.app.FindFirstRecordByData(TokensCollection, "user", userID)
	if err != nil {
		return auth.StoredToken{}, notFound(err)
	}
	return auth.StoredToken{
		Ciphertext: rec.GetString("refresh_ciphertext"),
		ExpiresAt:  timeOf(rec, "expires_at"),
	}, nil
}

// DeleteRefreshToken implements auth.UserTokenStore.
func (s *Store) DeleteRefreshToken(_ context.Context, userID string) error {
	return s.deleteWhere(TokensCollection, dbx.HashExp{"user": userID})
}

// CreateSession implements auth.SessionStore.
func (s *Store) CreateSession(_ context.Context, sess auth.Session) error {
	col, err := s.app.FindCollectionByNameOrId(SessionsCollection)
	if err != nil {
		return err
	}
	rec := core.NewRecord(col)
	rec.Set("token_hash", sess.TokenHash)
	rec.Set("user", sess.UserID)
	rec.Set("expires_at", sess.ExpiresAt)
	return s.app.Save(rec)
}

// SessionByHash implements auth.SessionStore.
func (s *Store) SessionByHash(_ context.Context, tokenHash string) (auth.Session, error) {
	rec, err := s.app.FindFirstRecordByData(SessionsCollection, "token_hash", tokenHash)
	if err != nil {
		return auth.Session{}, notFound(err)
	}
	return auth.Session{
		TokenHash: rec.GetString("token_hash"),
		UserID:    rec.GetString("user"),
		ExpiresAt: timeOf(rec, "expires_at"),
	}, nil
}

// DeleteSession implements auth.SessionStore.
func (s *Store) DeleteSession(_ context.Context, tokenHash string) error {
	return s.deleteWhere(SessionsCollection, dbx.HashExp{"token_hash": tokenHash})
}

// DeleteUserSessions implements auth.SessionStore.
func (s *Store) DeleteUserSessions(_ context.Context, userID string) error {
	return s.deleteWhere(SessionsCollection, dbx.HashExp{"user": userID})
}

func (s *Store) deleteWhere(collection string, where dbx.Expression) error {
	return s.app.RunInTransaction(func(tx core.App) error {
		recs, err := tx.FindAllRecords(collection, where)
		if err != nil {
			return err
		}
		for _, rec := range recs {
			if err := tx.Delete(rec); err != nil {
				return err
			}
		}
		return nil
	})
}

func toUser(rec *core.Record) auth.User {
	return auth.User{ID: rec.Id, GitHubID: int64(rec.GetFloat("github_id")), Login: rec.GetString("login")}
}

func timeOf(rec *core.Record, field string) time.Time {
	dt := rec.GetDateTime(field)
	if dt.IsZero() {
		return time.Time{}
	}
	return dt.Time()
}

func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return auth.ErrNotFound
	}
	return err
}
