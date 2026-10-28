package pbstore

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// Comment collection names.
const (
	ThreadsCollection     = "galley_threads"
	CommentsCollection    = "galley_comments"
	ThreadReadsCollection = "galley_thread_reads"
)

// sealedMax bounds a sealed text field: base64url of a 12-byte nonce, the
// plaintext (comments limit it to 20 KB) and a 16-byte tag, with headroom.
const sealedMax = 30000

// As for the auth collections, every API rule stays nil (superusers only)
// and galley reads and writes these collections from Go. Sealed fields are
// also hidden, so even superuser API listings do not return them.
func init() {
	core.AppMigrations.Register(createCommentCollections, dropCommentCollections, "1793275200_galley_comments.go")
}

func createCommentCollections(app core.App) error {
	users, err := app.FindCollectionByNameOrId(UsersCollection)
	if err != nil {
		return err
	}
	minLine := types.Pointer(1.0)
	maxLine := types.Pointer(1_000_000.0)
	maxCol := types.Pointer(100_000.0)
	minZero := types.Pointer(0.0)
	sha := `^[0-9a-f]{40}([0-9a-f]{24})?$`

	threads := core.NewBaseCollection(ThreadsCollection)
	threads.Fields.Add(
		&core.NumberField{Name: "repo_id", Required: true, OnlyInt: true, Min: minLine},
		&core.TextField{Name: "repo_full_name", Max: 200},
		&core.TextField{Name: "path", Required: true, Max: 512},
		&core.TextField{Name: "commit_sha", Required: true, Pattern: sha},
		&core.NumberField{Name: "start_line", Required: true, OnlyInt: true, Min: minLine, Max: maxLine},
		&core.NumberField{Name: "end_line", Required: true, OnlyInt: true, Min: minLine, Max: maxLine},
		&core.NumberField{Name: "start_column", OnlyInt: true, Min: minZero, Max: maxCol},
		&core.NumberField{Name: "end_column", OnlyInt: true, Min: minZero, Max: maxCol},
		&core.TextField{Name: "quote_exact", Hidden: true, Max: sealedMax},
		&core.TextField{Name: "quote_prefix", Hidden: true, Max: 2048},
		&core.TextField{Name: "quote_suffix", Hidden: true, Max: 2048},
		&core.TextField{Name: "anchor_sha", Required: true, Pattern: sha},
		&core.NumberField{Name: "anchor_start_line", Required: true, OnlyInt: true, Min: minLine, Max: maxLine},
		&core.NumberField{Name: "anchor_end_line", Required: true, OnlyInt: true, Min: minLine, Max: maxLine},
		&core.NumberField{Name: "anchor_start_column", OnlyInt: true, Min: minZero, Max: maxCol},
		&core.NumberField{Name: "anchor_end_column", OnlyInt: true, Min: minZero, Max: maxCol},
		&core.SelectField{Name: "anchor_state", Required: true, MaxSelect: 1, Values: []string{"exact", "moved", "fuzzy", "orphaned"}},
		&core.SelectField{Name: "origin", Required: true, MaxSelect: 1, Values: []string{"source", "preview"}},
		&core.SelectField{Name: "status", Required: true, MaxSelect: 1, Values: []string{"open", "resolved"}},
		// Authors are kept as optional relations without cascade: deleting a
		// user must not delete the replies of others in their threads.
		&core.RelationField{Name: "created_by", CollectionId: users.Id, MaxSelect: 1},
		&core.TextField{Name: "created_by_login", Max: 100},
		&core.DateField{Name: "created_at", Required: true},
		&core.DateField{Name: "updated_at", Required: true},
		&core.RelationField{Name: "resolved_by", CollectionId: users.Id, MaxSelect: 1},
		&core.TextField{Name: "resolved_by_login", Max: 100},
		&core.DateField{Name: "resolved_at"},
		// comment_seq is the seq of the newest comment; read markers store it.
		&core.NumberField{Name: "comment_seq", OnlyInt: true, Min: minZero},
		// Phase 2: PR review comment the thread was exported to.
		&core.NumberField{Name: "export_pr_number", OnlyInt: true, Min: minZero},
		&core.NumberField{Name: "export_comment_id", OnlyInt: true, Min: minZero},
	)
	threads.AddIndex("idx_galley_threads_repo_path", false, "repo_id, path, start_line", "")
	threads.AddIndex("idx_galley_threads_repo_status", false, "repo_id, status", "")
	if err := app.Save(threads); err != nil {
		return err
	}

	cmts := core.NewBaseCollection(CommentsCollection)
	cmts.Fields.Add(
		&core.RelationField{Name: "thread", Required: true, CollectionId: threads.Id, MaxSelect: 1, CascadeDelete: true},
		&core.SelectField{Name: "author_kind", Required: true, MaxSelect: 1, Values: []string{"human", "ai"}},
		&core.RelationField{Name: "author_user", CollectionId: users.Id, MaxSelect: 1},
		&core.TextField{Name: "author_login", Max: 100},
		&core.TextField{Name: "ai_client", Max: 100},
		&core.TextField{Name: "ai_model", Max: 100},
		&core.TextField{Name: "body", Required: true, Hidden: true, Max: sealedMax},
		&core.TextField{Name: "suggestion", Hidden: true, Max: sealedMax},
		&core.TextField{Name: "suggestion_base_sha", Pattern: sha},
		// seq numbers the comments of a thread 1, 2, 3...; unread counts
		// compare it with read markers instead of millisecond timestamps.
		&core.NumberField{Name: "seq", Required: true, OnlyInt: true, Min: minLine},
		&core.DateField{Name: "created_at", Required: true},
		&core.DateField{Name: "edited_at"},
	)
	cmts.AddIndex("idx_galley_comments_thread", false, "thread, created_at", "")
	if err := app.Save(cmts); err != nil {
		return err
	}

	reads := core.NewBaseCollection(ThreadReadsCollection)
	reads.Fields.Add(
		&core.RelationField{Name: "user", Required: true, CollectionId: users.Id, MaxSelect: 1, CascadeDelete: true},
		&core.RelationField{Name: "thread", Required: true, CollectionId: threads.Id, MaxSelect: 1, CascadeDelete: true},
		&core.NumberField{Name: "last_read_seq", OnlyInt: true, Min: minZero},
		&core.DateField{Name: "last_read", Required: true},
	)
	reads.AddIndex("idx_galley_thread_reads_user_thread", true, "user, thread", "")
	reads.AddIndex("idx_galley_thread_reads_thread", false, "thread", "")
	return app.Save(reads)
}

func dropCommentCollections(app core.App) error {
	for _, name := range []string{ThreadReadsCollection, CommentsCollection, ThreadsCollection} {
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
