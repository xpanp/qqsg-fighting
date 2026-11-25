package store

import (
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"os"
	"path/filepath"
	"testing"
)

func TestManualMergeKeepsSourceIdentityAcrossRebuildAndCanReset(t *testing.T) {
	s := setup(t)
	a, b := batch("a", "one", 10000), batch("b", "two", 40000)
	if _, err := s.Ingest(a); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Ingest(b); err != nil {
		t.Fatal(err)
	}
	drain(t, s)
	events, _, err := s.Events(0, 100000)
	if err != nil || len(events) != 2 {
		t.Fatal(events, err)
	}
	first, second := events[0].ID, events[1].ID
	if _, err = s.SetOverride(model.Override{RequestID: "merge", EventID: second, MergeInto: first, Reason: "same battle"}); err != nil {
		t.Fatal(err)
	}
	drain(t, s)
	for n := 0; n < 2; n++ {
		if _, err = s.QueueFull(); err != nil {
			t.Fatal(err)
		}
		drain(t, s)
	}
	var identity string
	if err = s.DB.QueryRow(`SELECT event_id FROM event_links WHERE source_id='b' AND message_id='two'`).Scan(&identity); err != nil || identity != second {
		t.Fatalf("display merge changed source identity %s: %v", identity, err)
	}
	if _, err = s.SetOverride(model.Override{RequestID: "cycle", EventID: first, MergeInto: second, Reason: "invalid cycle"}); err == nil {
		t.Fatal("cyclic merge accepted")
	}
	b.Messages[0].Revision = 2
	b.Messages[0].Text = "[地图]Beta在战斗中击败了Alpha"
	if _, err = s.Ingest(b); err != nil {
		t.Fatal(err)
	}
	drain(t, s)
	events, _, err = s.Events(0, 100000)
	if err != nil || len(events) != 2 {
		t.Fatal(events, err)
	}
	for _, e := range events {
		if e.ID == first && (e.SourceCount != 2 || e.Status != "counted") {
			t.Fatal("partial job lost merged evidence", e)
		}
		if e.ID == second && e.Status != "duplicate" {
			t.Fatal("merge override lost", e)
		}
	}
	if _, err = s.SetOverride(model.Override{RequestID: "reset", EventID: second, Reset: true, Reason: "separate battles"}); err != nil {
		t.Fatal(err)
	}
	drain(t, s)
	events, _, err = s.Events(0, 100000)
	if err != nil || len(events) != 2 {
		t.Fatal(events, err)
	}
	for _, e := range events {
		if e.Status != "counted" || e.SourceCount != 1 {
			t.Fatal("reset did not restore independent events", e)
		}
	}
}

func TestNameFilesSnapshotsAndDatabaseBackup(t *testing.T) {
	s := setup(t)
	input := t.TempDir()
	for name, value := range map[string]string{"name_a.txt": "# names\nAlpha\nAlpha\n", "name_b.txt": "Beta\n", "name_others.txt": "Other\n", "aliases.tsv": "Alpha\tAlfa\n", "blacklist.txt": "Beta\n"} {
		if err := os.WriteFile(filepath.Join(input, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	config, err := ReadNameFiles(input)
	if err != nil || len(config.NameA) != 1 || len(config.Aliases) != 1 {
		t.Fatal(config, err)
	}
	id, _, err := s.SaveConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	drain(t, s)
	if _, err = os.Stat(filepath.Join(s.Dir, "names", "versions", id, "name_a.txt")); err != nil {
		t.Fatal("name file snapshot missing", err)
	}
	restoredDir := t.TempDir()
	if err = os.MkdirAll(filepath.Join(restoredDir, "db"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = s.Backup(filepath.Join(restoredDir, "db", "fighting.db")); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(restoredDir)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	recovered, err := restored.Config()
	if err != nil || recovered.ID != id {
		t.Fatal("database backup lost name version", recovered, err)
	}
	if _, err = os.Stat(filepath.Join(restoredDir, "names", "versions", id, "config.json")); err != nil {
		t.Fatal("name snapshot was not restored from database", err)
	}
}

func TestFutureDatabaseVersionRejected(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(`INSERT INTO migrations VALUES(99,0)`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if future, err := Open(dir); err == nil {
		future.Close()
		t.Fatal("future database version accepted by older binary")
	}
}
