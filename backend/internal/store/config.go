package store

import (
	"encoding/json"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"github.com/xpanp/qqsg-fighting/backend/internal/processing"
	"time"
)

func (s *Store) Config() (model.NameConfig, error) {
	var b []byte
	e := s.DB.QueryRow(`SELECT payload FROM configs WHERE id=(SELECT value FROM meta WHERE key='active_config')`).Scan(&b)
	var c model.NameConfig
	if e == nil {
		e = json.Unmarshal(b, &c)
	}
	return c, e
}

func (s *Store) Configs() ([]map[string]any, error) {
	rows, e := s.DB.Query(`SELECT id,created_at FROM configs ORDER BY created_at DESC`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	a := []map[string]any{}
	for rows.Next() {
		var id string
		var at int64
		if e = rows.Scan(&id, &at); e != nil {
			return nil, e
		}
		a = append(a, map[string]any{"id": id, "createdAtMs": at})
	}
	return a, rows.Err()
}

func (s *Store) SaveConfig(c model.NameConfig) (string, string, error) {
	if _, e := processing.NewResolver(c); e != nil {
		return "", "", e
	}
	c.ID = ID()
	c.CreatedAtMs = time.Now().UnixMilli()
	if e := s.writeConfigSnapshot(c); e != nil {
		return "", "", e
	}
	b, _ := json.Marshal(c)
	tx, e := s.DB.Begin()
	if e != nil {
		return "", "", e
	}
	defer tx.Rollback()
	_, e = tx.Exec(`INSERT INTO configs VALUES(?,?,?)`, c.ID, b, c.CreatedAtMs)
	if e == nil {
		_, e = tx.Exec(`UPDATE meta SET value=? WHERE key='active_config'`, c.ID)
	}
	if e != nil {
		return "", "", e
	}
	job, e := jobTx(tx, 0, 0, true)
	if e != nil {
		return "", "", e
	}
	if e = tx.Commit(); e != nil {
		return "", "", e
	}
	return c.ID, job, nil
}
