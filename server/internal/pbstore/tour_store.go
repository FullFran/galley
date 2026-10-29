package pbstore

import (
	"context"

	"github.com/pocketbase/pocketbase/core"

	"github.com/FullFran/galley/server/internal/comments"
)

func init() {
	core.AppMigrations.Register(addTourStatus, nil, "1793620800_galley_tour.go")
}

// addTourStatus is additive: existing users, tokens, sessions and notification
// preferences are untouched. User API rules remain private (all nil).
func addTourStatus(app core.App) error {
	users, err := app.FindCollectionByNameOrId(UsersCollection)
	if err != nil {
		return err
	}
	users.Fields.Add(&core.SelectField{
		Name: "tour_status", Hidden: true, MaxSelect: 1,
		Values: []string{"done", "skipped"},
	})
	return app.Save(users)
}

// TourStatus returns an empty string until a terminal status is recorded.
func (s *Store) TourStatus(_ context.Context, userID string) (string, error) {
	rec, err := s.app.FindRecordById(UsersCollection, userID)
	if err != nil {
		return "", notFound(err)
	}
	return rec.GetString("tour_status"), nil
}

// SaveTourStatus updates an existing user only; login upserts preserve it.
func (s *Store) SaveTourStatus(_ context.Context, userID, status string) error {
	if status != "done" && status != "skipped" {
		return &comments.ValidationError{Field: "status"}
	}
	return s.app.RunInTransaction(func(tx core.App) error {
		rec, err := tx.FindRecordById(UsersCollection, userID)
		if err != nil {
			return notFound(err)
		}
		rec.Set("tour_status", status)
		return tx.Save(rec)
	})
}
