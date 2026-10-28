package pbstore

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// DraftsCollection holds the server-side drafts.
const DraftsCollection = "galley_drafts"

// sealedDraftMax bounds the sealed content: base64url of a 12-byte nonce, up
// to 2 MB of plaintext and a 16-byte tag (about 2.8 million characters).
const sealedDraftMax = 2_900_000

// As for the other galley collections, every API rule stays nil (superusers
// only) and the content is hidden and sealed.
func init() {
	core.AppMigrations.Register(createDraftsCollection, dropCollections(DraftsCollection), "1793361600_galley_drafts.go")
}

func createDraftsCollection(app core.App) error {
	users, err := app.FindCollectionByNameOrId(UsersCollection)
	if err != nil {
		return err
	}
	c := core.NewBaseCollection(DraftsCollection)
	c.Fields.Add(
		// Deleting a user deletes their drafts.
		&core.RelationField{Name: "owner", Required: true, CollectionId: users.Id, MaxSelect: 1, CascadeDelete: true},
		&core.NumberField{Name: "repo_id", Required: true, OnlyInt: true, Min: types.Pointer(1.0)},
		&core.TextField{Name: "path", Required: true, Max: 512},
		&core.TextField{Name: "base_sha", Required: true, Pattern: `^[0-9a-f]{40}([0-9a-f]{24})?$`},
		&core.TextField{Name: "base_ref", Max: 255},
		&core.TextField{Name: "device", Max: 64},
		&core.NumberField{Name: "size", OnlyInt: true, Min: types.Pointer(0.0), Max: types.Pointer(float64(2 << 20))},
		&core.TextField{Name: "content", Hidden: true, Max: sealedDraftMax},
		// version is a random nonce renewed on every write (part of the ETag).
		&core.TextField{Name: "version", Required: true, Max: 32, Pattern: `^[a-z0-9]+$`},
		&core.DateField{Name: "updated_at", Required: true},
	)
	c.AddIndex("idx_galley_drafts_owner_repo_path", true, "owner, repo_id, path", "")
	c.AddIndex("idx_galley_drafts_updated", false, "updated_at", "")
	c.AddIndex("idx_galley_drafts_owner", false, "owner", "")
	return app.Save(c)
}

func dropCollections(names ...string) func(core.App) error {
	return func(app core.App) error {
		for _, name := range names {
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
}
