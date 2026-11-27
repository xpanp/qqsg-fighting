package store

import (
	"testing"

	"github.com/xpanp/qqsg-fighting/backend/internal/model"
)

func TestRestoreConfigCreatesNextVersionWithoutChangingHistory(t *testing.T) {
	s := setup(t)
	old, err := s.Config()
	if err != nil {
		t.Fatal(err)
	}
	changed, _, err := s.SaveConfigBy(model.NameConfig{NameA: []string{"Other"}}, "editor")
	if err != nil {
		t.Fatal(err)
	}
	restored, job, err := s.RestoreConfig(old.ID, "restorer")
	if err != nil || restored == old.ID || restored == changed || job == "" {
		t.Fatal(restored, job, err)
	}
	versions, err := s.Configs()
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) < 3 || versions[0]["restoredFrom"] != old.ID || versions[0]["actor"] != "restorer" || versions[1]["id"] != changed || versions[2]["id"] != old.ID || versions[0]["version"].(int64) <= versions[1]["version"].(int64) {
		t.Fatal(versions)
	}
	drain(t, s)
	var published string
	err = s.DB.QueryRow("SELECT value FROM meta WHERE key='published_config'").Scan(&published)
	if err != nil || published != restored {
		t.Fatal(published, err)
	}
}
