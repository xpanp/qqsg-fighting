package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/xpanp/qqsg-fighting/backend/internal/store"
)

func dailyBackups(ctx context.Context, s *store.Store, dataDir string) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if err := backupDay(s, filepath.Join(dataDir, "backups", "daily"), time.Now().UTC()); err != nil {
			slog.Error("daily backup failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func backupDay(s *store.Store, dir string, now time.Time) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	dest := filepath.Join(dir, now.Format("2006-01-02")+".db")
	if _, err := os.Stat(dest); errors.Is(err, os.ErrNotExist) {
		tempDir, err := os.MkdirTemp(dir, ".pending-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(tempDir)
		temp := filepath.Join(tempDir, "backup.db")
		if err = s.Backup(temp); err != nil {
			return err
		}
		if err = os.Chmod(temp, 0600); err != nil {
			return err
		}
		if err = os.Rename(temp, dest); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var files []string
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		if _, err := time.Parse("2006-01-02.db", e.Name()); err == nil {
			files = append(files, e.Name())
		}
	}
	for len(files) > 30 {
		if err := os.Remove(filepath.Join(dir, files[0])); err != nil {
			return err
		}
		files = files[1:]
	}
	return nil
}
