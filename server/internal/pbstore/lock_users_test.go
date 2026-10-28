package pbstore_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func TestBuiltInUsersCollectionIsLocked(t *testing.T) {
	_, app := newStore(t)
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	if users.ListRule != nil || users.ViewRule != nil || users.CreateRule != nil || users.UpdateRule != nil || users.DeleteRule != nil {
		t.Error("built-in users collection has a non-nil API rule")
	}
}

func TestAnonymousSignUpIsRejected(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:            "anonymous POST to users",
		Method:          http.MethodPost,
		URL:             "/api/collections/users/records",
		Body:            strings.NewReader(`{"email":"a@example.com","password":"12345678aA","passwordConfirm":"12345678aA"}`),
		Headers:         map[string]string{"Content-Type": "application/json"},
		ExpectedStatus:  http.StatusForbidden,
		ExpectedContent: []string{`"status":403`},
		TestAppFactory: func(t testing.TB) *tests.TestApp {
			app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: t.TempDir(), EncryptionEnv: "pb_test_env"})
			if err != nil {
				t.Fatal(err)
			}
			return app
		},
	}
	scenario.Test(t)
}
