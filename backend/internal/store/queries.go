package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"time"
)

var ErrQueryBudget = errors.New("query exceeds 20000 events or 32 MiB; narrow the time range")

func (s *Store) EventPage(start, end int64, limit, offset int) ([]model.Event, int, int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, 0, 0, err
	}
	defer tx.Rollback()
	var total int
	var version int64
	if err = tx.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='generation'`).Scan(&version); err != nil {
		return nil, 0, 0, err
	}
	if err = tx.QueryRow(`SELECT COUNT(*) FROM events WHERE event_at>=? AND event_at<?`, start, end).Scan(&total); err != nil {
		return nil, 0, 0, err
	}
	rows, err := tx.Query(`SELECT payload FROM events WHERE event_at>=? AND event_at<? ORDER BY event_at,id LIMIT ? OFFSET ?`, start, end, limit, offset)
	if err != nil {
		return nil, 0, 0, err
	}
	events := []model.Event{}
	for rows.Next() {
		var payload []byte
		if err = rows.Scan(&payload); err != nil {
			rows.Close()
			return nil, 0, 0, err
		}
		var event model.Event
		if err = json.Unmarshal(payload, &event); err != nil {
			rows.Close()
			return nil, 0, 0, err
		}
		events = append(events, event)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, 0, 0, err
	}
	return events, total, version, tx.Commit()
}
