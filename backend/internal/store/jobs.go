package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"github.com/xpanp/qqsg-fighting/backend/internal/processing"
	"log/slog"
	"strings"
	"time"
)

func jobTx(tx *sql.Tx, start, end int64, full bool) (string, error) {
	id := ID()
	_, e := tx.Exec(`INSERT INTO jobs(id,status,start_ms,end_ms,full,created_at)VALUES(?,'queued',?,?,?,?)`, id, start, end, full, time.Now().UnixMilli())
	if e == nil {
		_, e = tx.Exec(`INSERT INTO meta(key,value) VALUES('input_generation','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`)
	}
	return id, e
}

func (s *Store) QueueFull() (string, error) {
	tx, e := s.DB.Begin()
	if e != nil {
		return "", e
	}
	defer tx.Rollback()
	id, e := jobTx(tx, 0, 0, true)
	if e != nil {
		return "", e
	}
	return id, tx.Commit()
}

func (s *Store) Jobs() ([]model.Job, error) {
	rows, e := s.DB.Query(`SELECT id,status,error,created_at,finished_at FROM jobs ORDER BY created_at DESC LIMIT 100`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	a := []model.Job{}
	for rows.Next() {
		var j model.Job
		if e = rows.Scan(&j.ID, &j.Status, &j.Error, &j.CreatedAtMs, &j.FinishedAtMs); e != nil {
			return nil, e
		}
		a = append(a, j)
	}
	return a, rows.Err()
}

func (s *Store) ProcessOne(ctx context.Context) (bool, error) {
	var j model.Job
	e := s.DB.QueryRowContext(ctx, `SELECT id,start_ms,end_ms,full FROM jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1`).Scan(&j.ID, &j.StartMs, &j.EndMs, &j.Full)
	if e == sql.ErrNoRows {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if _, e = s.DB.ExecContext(ctx, `UPDATE jobs SET status='running' WHERE id=?`, j.ID); e != nil {
		return true, e
	}
	err := s.process(ctx, j)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			_, _ = s.DB.Exec(`UPDATE jobs SET status='queued' WHERE id=?`, j.ID)
		} else {
			_, _ = s.DB.Exec(`UPDATE jobs SET status='failed',error=?,finished_at=? WHERE id=?`, "processing failed; see server job log", time.Now().UnixMilli(), j.ID)
		}
	}
	if err != nil {
		return true, fmt.Errorf("job %s: %w", j.ID, err)
	}
	var published string
	_ = s.DB.QueryRow(`SELECT value FROM meta WHERE key='published_config'`).Scan(&published)
	slog.Info("processing job committed", "jobId", j.ID, "projectionVersion", s.Generation(), "configVersion", published)
	return true, nil
}

func (s *Store) process(ctx context.Context, j model.Job) error {
	// A short read transaction gives a consistent input/config snapshot. Work is outside the write transaction.
	tx, e := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var cb []byte
	e = tx.QueryRow(`SELECT payload FROM configs WHERE id=(SELECT value FROM meta WHERE key='active_config')`).Scan(&cb)
	if e != nil {
		return e
	}
	var c model.NameConfig
	if e = json.Unmarshal(cb, &c); e != nil {
		return e
	}
	var gen int64
	if e = tx.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='generation'`).Scan(&gen); e != nil {
		return e
	}
	var published string
	if e = tx.QueryRow(`SELECT value FROM meta WHERE key='published_config'`).Scan(&published); e != nil {
		return e
	}
	if published != c.ID {
		j.Full = true
	}
	var inputGeneration int64
	if err := tx.QueryRow(`SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='input_generation'),0)`).Scan(&inputGeneration); err != nil {
		return err
	}
	var publishedAlgorithm string
	if e = tx.QueryRow(`SELECT value FROM meta WHERE key='published_algorithm'`).Scan(&publishedAlgorithm); e != nil {
		return e
	}
	if publishedAlgorithm != processing.AlgorithmVersion {
		j.Full = true
	}
	where := ""
	args := []any{}
	if !j.Full {
		where = " AND m.event_at>=? AND m.event_at<?"
		args = append(args, j.StartMs-5000, j.EndMs+5000)
	}
	rows, e := tx.Query(`SELECT m.payload FROM messages m WHERE NOT EXISTS(SELECT 1 FROM messages n WHERE n.source_id=m.source_id AND n.session_id=m.session_id AND n.message_id=m.message_id AND n.revision>m.revision)`+where+` ORDER BY m.event_at,m.source_id,m.session_id,m.message_id`, args...)
	if e != nil {
		return e
	}
	sources := []model.SourceMessage{}
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&b); e != nil {
			rows.Close()
			return e
		}
		var s model.SourceMessage
		if e = json.Unmarshal(b, &s); e != nil {
			rows.Close()
			return e
		}
		sources = append(sources, s)
	}
	if e = rows.Err(); e != nil {
		rows.Close()
		return e
	}
	rows.Close()
	// Rebuild the complete membership closure of touched canonical events, including
	// boundary anchors outside the dirty range. This avoids losing linked evidence.
	identities := map[string]string{}
	oldIDs := map[string]bool{}
	sourceMap := map[string]bool{}
	for _, src := range sources {
		sourceMap[src.SourceID+"\x00"+src.SessionID+"\x00"+src.MessageID] = true
	}
	if j.Full {
		rows, e = tx.Query(`SELECT source_id,session_id,message_id,event_id FROM event_links`)
		if e != nil {
			return e
		}
		for rows.Next() {
			var a, b, d, id string
			if e = rows.Scan(&a, &b, &d, &id); e != nil {
				rows.Close()
				return e
			}
			identities[a+"\x00"+b+"\x00"+d] = id
			oldIDs[id] = true
		}
		rows.Close()
	} else {
		for i := 0; i < len(sources); i++ {
			src := sources[i]
			var id string
			e = tx.QueryRow(`SELECT event_id FROM event_links WHERE source_id=? AND session_id=? AND message_id=?`, src.SourceID, src.SessionID, src.MessageID).Scan(&id)
			if e == sql.ErrNoRows {
				continue
			}
			if e != nil {
				return e
			}
			identities[src.SourceID+"\x00"+src.SessionID+"\x00"+src.MessageID] = id
			if oldIDs[id] {
				continue
			}
			oldIDs[id] = true
			links, err := tx.Query(`SELECT source_id,session_id,message_id FROM event_links WHERE event_id=?`, id)
			if err != nil {
				return err
			}
			keys := [][3]string{}
			for links.Next() {
				var key [3]string
				if err = links.Scan(&key[0], &key[1], &key[2]); err != nil {
					links.Close()
					return err
				}
				keys = append(keys, key)
			}
			links.Close()
			for _, key := range keys {
				k := strings.Join(key[:], "\x00")
				identities[k] = id
				if sourceMap[k] {
					continue
				}
				var payload []byte
				err = tx.QueryRow(`SELECT payload FROM messages WHERE source_id=? AND session_id=? AND message_id=? ORDER BY revision DESC LIMIT 1`, key[0], key[1], key[2]).Scan(&payload)
				if err != nil {
					return err
				}
				var extra model.SourceMessage
				if err = json.Unmarshal(payload, &extra); err != nil {
					return err
				}
				sources = append(sources, extra)
				sourceMap[k] = true
			}
		}
	}
	rows, e = tx.Query(`SELECT event_id,payload FROM overrides`)
	if e != nil {
		return e
	}
	ovs := map[string]model.Override{}
	for rows.Next() {
		var id string
		var b []byte
		if e = rows.Scan(&id, &b); e != nil {
			rows.Close()
			return e
		}
		var o model.Override
		if e = json.Unmarshal(b, &o); e != nil {
			rows.Close()
			return e
		}
		ovs[id] = o
	}
	rows.Close()
	// Manual associations may span time ranges. Include their member closure without
	// rebinding a source's stable identity to the evidence-display target.
	if !j.Full {
		changed := true
		for changed {
			changed = false
			for id, override := range ovs {
				if override.MergeInto == "" || (!oldIDs[id] && !oldIDs[override.MergeInto]) {
					continue
				}
				for _, memberID := range []string{id, override.MergeInto} {
					if oldIDs[memberID] {
						continue
					}
					oldIDs[memberID] = true
					changed = true
					links, err := tx.Query(`SELECT m.payload FROM event_links l JOIN messages m ON m.source_id=l.source_id AND m.session_id=l.session_id AND m.message_id=l.message_id WHERE l.event_id=? AND NOT EXISTS(SELECT 1 FROM messages n WHERE n.source_id=m.source_id AND n.session_id=m.session_id AND n.message_id=m.message_id AND n.revision>m.revision)`, memberID)
					if err != nil {
						return err
					}
					for links.Next() {
						var payload []byte
						if err = links.Scan(&payload); err != nil {
							links.Close()
							return err
						}
						var member model.SourceMessage
						if err = json.Unmarshal(payload, &member); err != nil {
							links.Close()
							return err
						}
						key := member.SourceID + "\x00" + member.SessionID + "\x00" + member.MessageID
						identities[key] = memberID
						if !sourceMap[key] {
							sources = append(sources, member)
							sourceMap[key] = true
						}
					}
					err = links.Err()
					links.Close()
					if err != nil {
						return err
					}
				}
			}
		}
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	events, e := processing.BuildWithIdentityContext(ctx, sources, c, ovs, identities)
	if e != nil {
		return e
	}
	tx, e = s.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var active string
	if e = tx.QueryRow(`SELECT value FROM meta WHERE key='active_config'`).Scan(&active); e != nil {
		return e
	}
	if active != c.ID {
		_, e = tx.Exec(`UPDATE jobs SET status='queued' WHERE id=?`, j.ID)
		if e != nil {
			return e
		}
		return tx.Commit()
	}
	var currentGen int64
	if e = tx.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='generation'`).Scan(&currentGen); e != nil {
		return e
	}
	var currentInputGeneration int64
	if err := tx.QueryRow(`SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='input_generation'),0)`).Scan(&currentInputGeneration); err != nil {
		return err
	}
	if currentGen != gen || (j.Full && currentInputGeneration != inputGeneration) {
		_, e = tx.Exec(`UPDATE jobs SET status='queued' WHERE id=?`, j.ID)
		if e != nil {
			return e
		}
		return tx.Commit()
	}
	gen++
	if j.Full {
		_, e = tx.Exec(`DELETE FROM events; DELETE FROM event_links`)
	} else {
		for id := range oldIDs {
			if _, e = tx.Exec(`DELETE FROM events WHERE id=?`, id); e != nil {
				return e
			}
			if _, e = tx.Exec(`DELETE FROM event_links WHERE event_id=?`, id); e != nil {
				return e
			}
		}
	}
	if e != nil {
		return e
	}
	for _, ev := range events {
		b, _ := json.Marshal(ev)
		src, _ := json.Marshal(ev.Sources)
		_, e = tx.Exec(`INSERT INTO events VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET event_at=excluded.event_at,payload=excluded.payload,sources=excluded.sources,generation=excluded.generation`, ev.ID, ev.OccurredAtMs, b, src, gen)
		if e != nil {
			return e
		}
		for _, sm := range ev.Members {
			_, e = tx.Exec(`INSERT INTO event_links VALUES(?,?,?,?) ON CONFLICT(source_id,session_id,message_id) DO UPDATE SET event_id=excluded.event_id`, sm.SourceID, sm.SessionID, sm.MessageID, ev.ID)
			if e != nil {
				return e
			}
		}
	}
	_, e = tx.Exec(`UPDATE meta SET value=? WHERE key='published_config'`, c.ID)
	if e == nil {
		_, e = tx.Exec(`UPDATE meta SET value=? WHERE key='published_algorithm'`, processing.AlgorithmVersion)
	}
	if e == nil {
		_, e = tx.Exec(`UPDATE meta SET value=? WHERE key='generation'`, fmt.Sprint(gen))
	}
	if e == nil {
		_, e = tx.Exec(`UPDATE jobs SET status='done',finished_at=? WHERE id=?`, time.Now().UnixMilli(), j.ID)
	}
	if e != nil {
		return e
	}
	return tx.Commit()
}
