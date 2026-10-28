package pbstore

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// PocketBase creates a built-in "users" auth collection whose CreateRule is
// "" (anyone may sign up). galley does not use it, so its API rules are set
// to nil (superusers only). The collection is kept rather than deleted so
// later PocketBase system migrations that expect it keep working.
func init() {
	core.AppMigrations.Register(lockBuiltInUsers, unlockBuiltInUsers, "1793188801_galley_lock_users.go")
}

func lockBuiltInUsers(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return nil // already removed by an operator; nothing to lock
	}
	users.ListRule = nil
	users.ViewRule = nil
	users.CreateRule = nil
	users.UpdateRule = nil
	users.DeleteRule = nil
	return app.Save(users)
}

// unlockBuiltInUsers restores PocketBase's default rules.
func unlockBuiltInUsers(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return nil
	}
	owner := "id = @request.auth.id"
	users.ListRule = types.Pointer(owner)
	users.ViewRule = types.Pointer(owner)
	users.CreateRule = types.Pointer("")
	users.UpdateRule = types.Pointer(owner)
	users.DeleteRule = types.Pointer(owner)
	return app.Save(users)
}
