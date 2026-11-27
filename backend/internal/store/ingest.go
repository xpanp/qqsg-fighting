package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"github.com/xpanp/qqsg-fighting/backend/internal/processing"
	"strings"
	"time"
)

func (s *Store) Ingest(b model.Batch) (model.Ack, error) {
	ack := model.Ack{BatchID: b.BatchID, Accepted: []model.Item{}, Rejected: []model.Item{}}
	tx, e := s.DB.Begin()
	if e != nil {
		return ack, e
	}
	defer tx.Rollback()
	now := time.Now().UnixMilli()
	contextBytes, _ := json.Marshal(b.Context)
	var existing string
	e = tx.QueryRow(`SELECT context FROM capture_sessions WHERE source_id=? AND session_id=?`, b.SourceID, b.SessionID).Scan(&existing)
	if e == sql.ErrNoRows {
		_, e = tx.Exec(`INSERT INTO capture_sessions VALUES(?,?,?)`, b.SourceID, b.SessionID, contextBytes)
	} else if e == nil {
		var c model.Context
		_ = json.Unmarshal([]byte(existing), &c)
		if c.Realm != b.Context.Realm || c.Line != b.Context.Line || c.Character != b.Context.Character || c.SessionStartedAtMs != b.Context.SessionStartedAtMs {
			return ack, fmt.Errorf("session_context_conflict")
		}
	}
	if e != nil {
		return ack, e
	}
	start, end := int64(0), int64(0)
	for _, m := range b.Messages {
		item := model.Item{ID: m.ID, SessionID: m.SessionID, Revision: m.Revision}
		reject := func(code string) { item.Code = code; ack.Rejected = append(ack.Rejected, item) }
		if m.SessionID != b.SessionID || m.ID == "" || len(m.ID) > 160 || m.Revision < 1 || m.FirstObservedAtMs <= 0 || m.LastObservedAtMs < m.FirstObservedAtMs || len(m.Text) > 16384 || strings.TrimSpace(m.Text) == "" {
			reject("invalid_message")
			continue
		}
		stable, _ := json.Marshal(struct {
			ID, SessionID, Text    string
			Revision               int
			FirstObservedAtMs      int64
			GameTime, FirstFrameID string
		}{m.ID, m.SessionID, m.Text, m.Revision, m.FirstObservedAtMs, m.GameTime, m.FirstFrameID})
		hash := Hash(string(stable))
		var old string
		e = tx.QueryRow(`SELECT stable_hash FROM messages WHERE source_id=? AND session_id=? AND message_id=? AND revision=?`, b.SourceID, b.SessionID, m.ID, m.Revision).Scan(&old)
		if e == nil {
			if old != hash {
				reject("revision_conflict")
			} else {
				ack.Accepted = append(ack.Accepted, item)
			}
			continue
		}
		if e != sql.ErrNoRows {
			return ack, e
		}
		at := processing.EventTime(m, b.Context)
		sm := model.SourceMessage{SourceID: b.SourceID, SessionID: b.SessionID, MessageID: m.ID, Revision: m.Revision, Text: m.Text, FirstObservedAtMs: m.FirstObservedAtMs, LastObservedAtMs: m.LastObservedAtMs, GameTime: processing.GameTime(m.Text, m.GameTime), EventAtMs: at, ReceivedAtMs: now, Context: b.Context}
		p, _ := json.Marshal(sm)
		_, e = tx.Exec(`INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)`, b.SourceID, b.SessionID, m.ID, m.Revision, hash, p, at, now)
		if e != nil {
			return ack, e
		}
		// Include earlier event time if a correction changes in-game timestamp.
		var minOld, maxOld sql.NullInt64
		e = tx.QueryRow(`SELECT MIN(event_at),MAX(event_at) FROM messages WHERE source_id=? AND session_id=? AND message_id=?`, b.SourceID, b.SessionID, m.ID).Scan(&minOld, &maxOld)
		if e != nil {
			return ack, e
		}
		lo, hi := at, at
		if minOld.Valid && minOld.Int64 < lo {
			lo = minOld.Int64
		}
		if maxOld.Valid && maxOld.Int64 > hi {
			hi = maxOld.Int64
		}
		if start == 0 || lo < start {
			start = lo
		}
		if hi > end {
			end = hi
		}
		ack.Accepted = append(ack.Accepted, item)
	}
	if start != 0 {
		if ack.JobID, e = jobTx(tx, start-5000, end+5001, false); e != nil {
			return ack, e
		}
	}
	e = tx.Commit()
	return ack, e
}
