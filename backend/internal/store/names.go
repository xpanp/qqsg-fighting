package store

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"os"
	"path/filepath"
	"strings"
)

// Database versions are authoritative; immutable files support reading, import and backup.
func (s *Store) writeConfigSnapshot(c model.NameConfig) error {
	root := filepath.Join(s.Dir, "names", "versions")
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	content, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	destination := filepath.Join(root, c.ID)
	old, err := os.ReadFile(filepath.Join(destination, "config.json"))
	if err == nil {
		if bytes.Equal(old, content) {
			return nil
		}
		return fmt.Errorf("immutable name snapshot conflicts with database version %s", c.ID)
	}
	if !os.IsNotExist(err) {
		return err
	}
	stage, err := os.MkdirTemp(root, ".pending-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	aliases := []string{}
	for _, a := range c.Aliases {
		aliases = append(aliases, a.Canonical+"\t"+a.Alias)
	}
	files := map[string][]string{"name_a.txt": c.NameA, "name_b.txt": c.NameB, "name_others.txt": c.NameOthers, "aliases.tsv": aliases, "blacklist.txt": c.Blacklist}
	for name, rows := range files {
		text := strings.Join(rows, "\n")
		if len(rows) > 0 {
			text += "\n"
		}
		if err = os.WriteFile(filepath.Join(stage, name), []byte(text), 0600); err != nil {
			return err
		}
	}
	if err = os.WriteFile(filepath.Join(stage, "config.json"), content, 0600); err != nil {
		return err
	}
	return os.Rename(stage, destination)
}

func ReadNameFiles(dir string) (model.NameConfig, error) {
	c := model.NameConfig{NameA: []string{}, NameB: []string{}, NameOthers: []string{}, Aliases: []model.Alias{}, Blacklist: []string{}}
	for _, f := range []struct {
		name     string
		target   *[]string
		optional bool
	}{{"name_a.txt", &c.NameA, false}, {"name_b.txt", &c.NameB, false}, {"name_others.txt", &c.NameOthers, false}, {"blacklist.txt", &c.Blacklist, true}} {
		rows, err := nameLines(filepath.Join(dir, f.name), f.optional)
		if err != nil {
			return c, err
		}
		seen := map[string]bool{}
		for _, row := range rows {
			if !seen[row] {
				*f.target = append(*f.target, row)
				seen[row] = true
			}
		}
	}
	rows, err := nameLines(filepath.Join(dir, "aliases.tsv"), true)
	if err != nil {
		return c, err
	}
	for _, row := range rows {
		parts := strings.Split(row, "\t")
		if len(parts) < 2 {
			return c, fmt.Errorf("aliases.tsv requires canonical TAB alias")
		}
		for _, alias := range parts[1:] {
			alias = strings.TrimSpace(alias)
			if alias != "" {
				c.Aliases = append(c.Aliases, model.Alias{Canonical: strings.TrimSpace(parts[0]), Alias: alias})
			}
		}
	}
	return c, nil
}
func nameLines(path string, optional bool) ([]string, error) {
	file, err := os.Open(path)
	if optional && os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	rows := []string{}
	for scanner.Scan() {
		row := strings.TrimSpace(strings.TrimPrefix(scanner.Text(), "\ufeff"))
		if row != "" && !strings.HasPrefix(row, "#") {
			rows = append(rows, row)
		}
	}
	return rows, scanner.Err()
}
