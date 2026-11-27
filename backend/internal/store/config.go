package store

import (
	"encoding/json"
	"fmt"
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
	if e := s.ensureConfigAudit(); e != nil {
		return nil, e
	}
	rows, e := s.DB.Query(`SELECT configs.id,created_at, COALESCE(actor,'legacy'), COALESCE(action,'save'), COALESCE(restored_from,''), version FROM configs LEFT JOIN config_audit ON configs.id=config_audit.id ORDER BY version DESC`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	a := []map[string]any{}
	for rows.Next() {
		var id string
		var at, version int64
		var actor, action, from string
		if e = rows.Scan(&id, &at, &actor, &action, &from, &version); e != nil {
			return nil, e
		}
		a = append(a, map[string]any{"id": id, "createdAtMs": at, "version": version, "actor": actor, "action": action, "restoredFrom": from})
	}
	return a, rows.Err()
}

func (s *Store) SaveConfig(c model.NameConfig) (string, string, error) {
	return s.SaveConfigBy(c, "system")
}

func (s *Store) ensureConfigAudit() error {
	_, err := s.DB.Exec(`CREATE TABLE IF NOT EXISTS config_audit (id TEXT PRIMARY KEY REFERENCES configs(id), actor TEXT NOT NULL, action TEXT NOT NULL, restored_from TEXT NOT NULL, version INTEGER NOT NULL UNIQUE); INSERT OR IGNORE INTO config_audit SELECT id,'legacy','save','',rowid FROM configs`)
	return err
}

func (s *Store) SaveConfigBy(c model.NameConfig, actor string) (string, string, error) {
	return s.saveConfig(c, actor, "save", "")
}

func (s *Store) RestoreConfig(id, actor string) (string, string, error) {
	var payload []byte
	if err := s.DB.QueryRow(`SELECT payload FROM configs WHERE id=?`, id).Scan(&payload); err != nil {
		return "", "", fmt.Errorf("load config to restore: %w", err)
	}
	var c model.NameConfig
	if err := json.Unmarshal(payload, &c); err != nil {
		return "", "", err
	}
	return s.saveConfig(c, actor, "restore", id)
}

func (s *Store) saveConfig(c model.NameConfig, actor, action, from string) (string, string, error) {
	if e := s.ensureConfigAudit(); e != nil {
		return "", "", e
	}
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
	if _, e = tx.Exec(`INSERT INTO config_audit SELECT ?,?,?,?,COALESCE(MAX(version),0)+1 FROM config_audit`, c.ID, actor, action, from); e != nil {
		return "", "", e
	}
	job, e := jobTx(tx, 0, 0, true)
	if e != nil {
		return "", "", e
	}
	if _, e = tx.Exec(`INSERT INTO meta(key,value) VALUES('roster_job',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, job); e != nil {
		return "", "", e
	}
	if e = tx.Commit(); e != nil {
		return "", "", e
	}
	return c.ID, job, nil
}
