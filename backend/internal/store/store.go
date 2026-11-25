package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"time"
)

type Store struct {
	DB  *sql.DB
	Dir string
}

func ID() string {
	b := make([]byte, 18)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}

func Hash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func Open(dir string) (*Store, error) {
	if e := os.MkdirAll(filepath.Join(dir, "db"), 0700); e != nil {
		return nil, e
	}
	db, e := sql.Open("sqlite", filepath.Join(dir, "db", "fighting.db"))
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	s := &Store{DB: db, Dir: dir}
	var hasMigrations int
	if e = db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='migrations'`).Scan(&hasMigrations); e != nil {
		db.Close()
		return nil, e
	}
	if hasMigrations != 0 {
		var version int
		if e = db.QueryRow(`SELECT COALESCE(MAX(version),0) FROM migrations`).Scan(&version); e != nil {
			db.Close()
			return nil, e
		}
		if version > 1 {
			db.Close()
			return nil, fmt.Errorf("database schema %d is newer than supported version 1; use compatible binary", version)
		}
	}
	if _, e = db.Exec(schema); e != nil {
		db.Close()
		return nil, e
	}
	var n int
	if e = db.QueryRow(`SELECT COUNT(*) FROM configs`).Scan(&n); e != nil {
		return nil, e
	}
	if n == 0 {
		c := model.NameConfig{ID: ID(), NameA: []string{}, NameB: []string{}, NameOthers: []string{}, Aliases: []model.Alias{}, Blacklist: []string{}, CreatedAtMs: time.Now().UnixMilli()}
		b, _ := json.Marshal(c)
		_, e = db.Exec(`INSERT INTO configs(id,payload,created_at)VALUES(?,?,?); INSERT INTO meta(key,value) VALUES('active_config',?); INSERT INTO meta(key,value) VALUES('generation','0')`, c.ID, b, c.CreatedAtMs, c.ID)
	}
	if e == nil {
		_, e = db.Exec(`INSERT OR IGNORE INTO meta(key,value) SELECT 'published_config',value FROM meta WHERE key='active_config'`)
	}
	if e == nil {
		_, e = db.Exec(`INSERT OR IGNORE INTO meta(key,value) VALUES('published_algorithm','')`)
	}
	if e == nil {
		var c model.NameConfig
		c, e = s.Config()
		if e == nil {
			e = s.writeConfigSnapshot(c)
		}
	}
	if e != nil {
		db.Close()
		return nil, e
	}
	return s, e
}

//go:embed migrations/0001.sql
var schema string

func (s *Store) Close() error { return s.DB.Close() }
