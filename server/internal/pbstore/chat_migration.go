package pbstore

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// Chat collection names.
const (
	ChatMessagesCollection = "galley_chat_messages"
	ChatReadsCollection    = "galley_chat_reads"
)

// sealedChatMax bounds a sealed chat body (4 KB of plaintext).
const sealedChatMax = 8000

// Every API rule stays nil (superusers only): galley users are not
// PocketBase auth records, so record rules and PocketBase realtime could not
// express the per-repository permission anyway. Streams come from Go.
func init() {
	core.AppMigrations.Register(createChatCollections, dropCollections(ChatReadsCollection, ChatMessagesCollection), "1793361601_galley_chat.go")
}

func createChatCollections(app core.App) error {
	users, err := app.FindCollectionByNameOrId(UsersCollection)
	if err != nil {
		return err
	}
	one := types.Pointer(1.0)
	zero := types.Pointer(0.0)

	msgs := core.NewBaseCollection(ChatMessagesCollection)
	msgs.Fields.Add(
		&core.NumberField{Name: "repo_id", Required: true, OnlyInt: true, Min: one},
		// seq numbers a repository's messages 1, 2, 3...
		&core.NumberField{Name: "seq", Required: true, OnlyInt: true, Min: one},
		// The author's user id, as plain text rather than a relation: the
		// sealed body is bound to it, and deleting a user must neither delete
		// nor (by clearing a relation) unseal the conversation.
		&core.TextField{Name: "author", Max: 15},
		&core.TextField{Name: "author_login", Max: 100},
		&core.TextField{Name: "body", Required: true, Hidden: true, Max: sealedChatMax},
		&core.DateField{Name: "created_at", Required: true},
	)
	msgs.AddIndex("idx_galley_chat_messages_repo_seq", true, "repo_id, seq", "")
	if err := app.Save(msgs); err != nil {
		return err
	}

	reads := core.NewBaseCollection(ChatReadsCollection)
	reads.Fields.Add(
		&core.RelationField{Name: "user", Required: true, CollectionId: users.Id, MaxSelect: 1, CascadeDelete: true},
		&core.NumberField{Name: "repo_id", Required: true, OnlyInt: true, Min: one},
		&core.NumberField{Name: "last_read_seq", OnlyInt: true, Min: zero},
	)
	reads.AddIndex("idx_galley_chat_reads_user_repo", true, "user, repo_id", "")
	return app.Save(reads)
}
