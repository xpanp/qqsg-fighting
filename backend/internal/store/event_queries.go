package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"path/filepath"
	"time"
)

func (s *Store) Events(start, end int64) ([]model.Event, int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	tx, e := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if e != nil {
		return nil, 0, e
	}
	defer tx.Rollback()
	var count, bytes int64
	if e = tx.QueryRow(`SELECT COUNT(*),COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM events WHERE event_at>=? AND event_at<?`, start, end).Scan(&count, &bytes); e != nil {
		return nil, 0, e
	}
	if count > 20000 || bytes > 32*1024*1024 {
		return nil, 0, ErrQueryBudget
	}
	var gen int64
	if e = tx.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='generation'`).Scan(&gen); e != nil {
		return nil, 0, e
	}
	rows, e := tx.Query(`SELECT payload FROM events WHERE event_at>=? AND event_at<? ORDER BY event_at,id`, start, end)
	if e != nil {
		return nil, 0, e
	}
	a := []model.Event{}
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&b); e != nil {
			rows.Close()
			return nil, 0, e
		}
		var ev model.Event
		if e = json.Unmarshal(b, &ev); e != nil {
			rows.Close()
			return nil, 0, e
		}
		a = append(a, ev)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, 0, e
	}
	return a, gen, tx.Commit()
}

func (s *Store) Event(id string) (model.Event, []model.SourceMessage, []model.Override, error) {
	var ev model.Event
	var b, src []byte
	e := s.DB.QueryRow(`SELECT payload,sources FROM events WHERE id=?`, id).Scan(&b, &src)
	if e != nil {
		return ev, nil, nil, e
	}
	if e = json.Unmarshal(b, &ev); e != nil {
		return ev, nil, nil, e
	}
	a := []model.SourceMessage{}
	if e = json.Unmarshal(src, &a); e != nil {
		return ev, nil, nil, e
	}
	ovs := []model.Override{}
	rows, e := s.DB.Query(`SELECT payload FROM audit WHERE event_id=? ORDER BY created_at`, id)
	if e != nil {
		return ev, a, ovs, e
	}
	defer rows.Close()
	for rows.Next() {
		var p []byte
		if e = rows.Scan(&p); e != nil {
			return ev, a, ovs, e
		}
		var o model.Override
		if e = json.Unmarshal(p, &o); e != nil {
			return ev, a, ovs, e
		}
		ovs = append(ovs, o)
	}
	return ev, a, ovs, rows.Err()
}

func (s *Store) Generation() int64 {
	var gen int64
	_ = s.DB.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='generation'`).Scan(&gen)
	return gen
}

func (s *Store) Backup(destination string) error {
	if !filepath.IsAbs(destination) {
		return errors.New("absolute destination required")
	}
	_, e := s.DB.Exec(`VACUUM INTO ?`, destination)
	return e
}
