package pbstore

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// Admin collection names.
const (
	RepoActivityCollection  = "galley_repo_activity"
	RepoAllowlistCollection = "galley_repo_allowlist"
	DraftSharesCollection   = "galley_draft_shares"
	AuditCollection         = "galley_audit"
)

// As for every galley collection, the API rules stay nil (superusers only).
// None of these collections holds free text or content: logins, paths,
// record ids, actions and times only, so nothing needs sealing.
func init() {
	core.AppMigrations.Register(createAdminCollections,
		dropCollections(AuditCollection, DraftSharesCollection, RepoAllowlistCollection, RepoActivityCollection),
		"1793448000_galley_admin.go")
}

func createAdminCollections(app core.App) error {
	users, err := app.FindCollectionByNameOrId(UsersCollection)
	if err != nil {
		return err
	}
	draftsCol, err := app.FindCollectionByNameOrId(DraftsCollection)
	if err != nil {
		return err
	}
	one := types.Pointer(1.0)
	zero := types.Pointer(0.0)

	activity := core.NewBaseCollection(RepoActivityCollection)
	activity.Fields.Add(
		&core.RelationField{Name: "user", Required: true, CollectionId: users.Id, MaxSelect: 1, CascadeDelete: true},
		&core.NumberField{Name: "repo_id", Required: true, OnlyInt: true, Min: one},
		&core.SelectField{Name: "permission", Required: true, MaxSelect: 1, Values: []string{"read", "write", "admin"}},
		&core.DateField{Name: "first_seen", Required: true},
		&core.DateField{Name: "last_seen", Required: true},
	)
	activity.AddIndex("idx_galley_repo_activity_user_repo", true, "user, repo_id", "")
	activity.AddIndex("idx_galley_repo_activity_repo_seen", false, "repo_id, last_seen", "")
	if err := app.Save(activity); err != nil {
		return err
	}

	allow := core.NewBaseCollection(RepoAllowlistCollection)
	allow.Fields.Add(
		&core.NumberField{Name: "repo_id", Required: true, OnlyInt: true, Min: one},
		&core.NumberField{Name: "github_id", OnlyInt: true, Min: zero},
		&core.TextField{Name: "login", Max: 39, Pattern: `^[a-z0-9-]*$`},
		&core.TextField{Name: "added_by", Max: 15},
		&core.DateField{Name: "created_at", Required: true},
	)
	allow.AddIndex("idx_galley_repo_allowlist_repo", false, "repo_id", "")
	if err := app.Save(allow); err != nil {
		return err
	}

	shares := core.NewBaseCollection(DraftSharesCollection)
	shares.Fields.Add(
		// Deleting the draft (after a save, retention or revocation) or its
		// owner deletes the grant.
		&core.RelationField{Name: "draft", Required: true, CollectionId: draftsCol.Id, MaxSelect: 1, CascadeDelete: true},
		&core.RelationField{Name: "owner", Required: true, CollectionId: users.Id, MaxSelect: 1, CascadeDelete: true},
		&core.NumberField{Name: "repo_id", Required: true, OnlyInt: true, Min: one},
		&core.TextField{Name: "path", Required: true, Max: 512},
		&core.DateField{Name: "created_at", Required: true},
		&core.DateField{Name: "expires_at", Required: true},
		&core.DateField{Name: "revoked_at"},
	)
	shares.AddIndex("idx_galley_draft_shares_repo_expires", false, "repo_id, expires_at", "")
	shares.AddIndex("idx_galley_draft_shares_owner_repo_path", false, "owner, repo_id, path", "")
	if err := app.Save(shares); err != nil {
		return err
	}

	audit := core.NewBaseCollection(AuditCollection)
	audit.Fields.Add(
		&core.NumberField{Name: "repo_id", Required: true, OnlyInt: true, Min: one},
		// Plain ids rather than relations: the trail outlives its users.
		&core.TextField{Name: "actor", Required: true, Max: 15},
		&core.TextField{Name: "actor_login", Max: 100},
		&core.TextField{Name: "action", Required: true, Max: 32, Pattern: `^[a-z_]+$`},
		&core.TextField{Name: "target", Max: 64},
		&core.DateField{Name: "at", Required: true},
	)
	audit.AddIndex("idx_galley_audit_repo_at", false, "repo_id, at", "")
	return app.Save(audit)
}
