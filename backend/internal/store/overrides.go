package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"time"
)

func (s *Store) SetOverride(o model.Override) (string, error) {
	tx, e := s.DB.Begin()
	if e != nil {
		return "", e
	}
	defer tx.Rollback()
	o.CreatedAtMs = 0
	patch, _ := json.Marshal(o)
	var prior []byte
	e = tx.QueryRow(`SELECT payload FROM audit WHERE request_id=?`, o.RequestID).Scan(&prior)
	if e == nil {
		if string(patch) != string(prior) {
			return "", fmt.Errorf("request_id_conflict")
		}
		return "", nil
	}
	if e != sql.ErrNoRows {
		return "", e
	}
	var at int64
	if e = tx.QueryRow(`SELECT event_at FROM events WHERE id=?`, o.EventID).Scan(&at); e != nil {
		return "", e
	}
	var oldPayload []byte
	e = tx.QueryRow(`SELECT payload FROM overrides WHERE event_id=?`, o.EventID).Scan(&oldPayload)
	if e == nil && !o.Reset {
		var old model.Override
		if e = json.Unmarshal(oldPayload, &old); e != nil {
			return "", e
		}
		if o.Killer == "" {
			o.Killer = old.Killer
		}
		if o.Victim == "" {
			o.Victim = old.Victim
		}
		if o.Status == "" {
			o.Status = old.Status
		}
		if !o.Split {
			o.Split = old.Split
		}
		if o.MergeInto == "" {
			o.MergeInto = old.MergeInto
		}
	} else if e != nil && e != sql.ErrNoRows {
		return "", e
	}
	if !o.Reset && o.MergeInto != "" {
		seen := map[string]bool{o.EventID: true}
		for target := o.MergeInto; target != ""; {
			if seen[target] {
				return "", fmt.Errorf("merge_cycle")
			}
			seen[target] = true
			var payload []byte
			err := tx.QueryRow(`SELECT payload FROM overrides WHERE event_id=?`, target).Scan(&payload)
			if err == sql.ErrNoRows {
				break
			}
			if err != nil {
				return "", err
			}
			var next model.Override
			if err = json.Unmarshal(payload, &next); err != nil {
				return "", err
			}
			target = next.MergeInto
		}
	}
	o.CreatedAtMs = time.Now().UnixMilli()
	effective, _ := json.Marshal(o)
	_, e = tx.Exec(`INSERT INTO audit VALUES(?,'event_override',?,?,?)`, o.RequestID, o.EventID, patch, o.CreatedAtMs)
	if e == nil {
		if o.Reset {
			_, e = tx.Exec(`DELETE FROM overrides WHERE event_id=?`, o.EventID)
		} else {
			_, e = tx.Exec(`INSERT INTO overrides VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET payload=excluded.payload`, o.EventID, effective)
		}
	}
	if e != nil {
		return "", e
	}
	start, end := at-5000, at+5001
	if o.MergeInto != "" {
		var target int64
		if e = tx.QueryRow(`SELECT event_at FROM events WHERE id=?`, o.MergeInto).Scan(&target); e != nil {
			return "", e
		}
		start = min(start, target-5000)
		end = max(end, target+5001)
	}
	id, e := jobTx(tx, start, end, o.Reset)
	if e != nil {
		return "", e
	}
	return id, tx.Commit()
}
