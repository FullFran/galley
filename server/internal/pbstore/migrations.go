package pbstore

import (
	"github.com/pocketbase/pocketbase/core"
)

// Collection names. They are prefixed so they never collide with
// PocketBase's built-in "users" auth collection.
const (
	UsersCollection    = "galley_users"
	TokensCollection   = "galley_github_tokens"
	SessionsCollection = "galley_sessions"
)

// All API rules stay nil (the PocketBase default for new collections), so
// only superusers can reach these collections through the PocketBase API.
// galley reads and writes them from Go only.
func init() {
	core.AppMigrations.Register(createAuthCollections, dropAuthCollections, "1793188800_galley_auth.go")
}

func createAuthCollections(app core.App) error {
	users := core.NewBaseCollection(UsersCollection)
	users.Fields.Add(
		&core.NumberField{Name: "github_id", Required: true, OnlyInt: true},
		&core.TextField{Name: "login", Required: true, Max: 100},
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
	)
	users.AddIndex("idx_galley_users_github_id", true, "github_id", "")
	if err := app.Save(users); err != nil {
		return err
	}

	tokens := core.NewBaseCollection(TokensCollection)
	tokens.Fields.Add(
		&core.RelationField{Name: "user", Required: true, CollectionId: users.Id, MaxSelect: 1, CascadeDelete: true},
		&core.TextField{Name: "refresh_ciphertext", Required: true, Hidden: true, Max: 2048},
		&core.DateField{Name: "expires_at"},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
	)
	tokens.AddIndex("idx_galley_github_tokens_user", true, "user", "")
	if err := app.Save(tokens); err != nil {
		return err
	}

	sessions := core.NewBaseCollection(SessionsCollection)
	sessions.Fields.Add(
		&core.TextField{Name: "token_hash", Required: true, Hidden: true, Min: 64, Max: 64},
		&core.RelationField{Name: "user", Required: true, CollectionId: users.Id, MaxSelect: 1, CascadeDelete: true},
		&core.DateField{Name: "expires_at", Required: true},
		&core.AutodateField{Name: "created", OnCreate: true},
	)
	sessions.AddIndex("idx_galley_sessions_token_hash", true, "token_hash", "")
	sessions.AddIndex("idx_galley_sessions_user", false, "user", "")
	return app.Save(sessions)
}

func dropAuthCollections(app core.App) error {
	for _, name := range []string{SessionsCollection, TokensCollection, UsersCollection} {
		c, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			continue
		}
		if err := app.Delete(c); err != nil {
			return err
		}
	}
	return nil
}
