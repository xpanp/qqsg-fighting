package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOfflineReportUsesObservedDateAndSharedRules(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{
		"name_a.txt": "甲\n", "name_b.txt": "乙\n", "name_others.txt": "", "blacklist.txt": "小号\n",
		"message.txt": "2026-11-26 00:00:02.123  [地图][23:59:58]你在战斗中击败了乙\n2026-11-26 00:00:03.123  [地图]甲在战斗中击败了小号\n无效时间  [地图]甲在战斗中击败了乙\n",
	}
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	output := filepath.Join(dir, "result.xlsx")
	if err := report([]string{"--input", filepath.Join(dir, "message.txt"), "--roster", dir, "--output", output, "--self-name", "甲"}); err != nil {
		t.Fatal(err)
	}
	z, err := zip.OpenReader(output)
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	if len(z.File) < 6 {
		t.Fatal("missing workbook sheets")
	}
	b, err := os.ReadFile(output + ".json")
	if err != nil {
		t.Fatal(err)
	}
	summary := string(b)
	for _, needle := range []string{"invalid observation timestamp", "blacklist", "algorithmVersion"} {
		if !strings.Contains(summary, needle) {
			t.Fatalf("summary missing %q", needle)
		}
	}
}
