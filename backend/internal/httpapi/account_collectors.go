package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/xpanp/qqsg-fighting/backend/internal/store"
)

func (s *Server) registerAccountCollector(w http.ResponseWriter, r *http.Request) {
	a := r.Context().Value(accountKey{}).(accountSession)
	var body struct {
		InstallationID string `json:"installationId"`
		Region         string `json:"region"`
	}
	if !decode(w, r, &body, 1024) {
		return
	}
	if body.Region != supportedRegion || a.Region != body.Region {
		fail(w, 403, "unsupported collector region")
		return
	}
	if !isAccountASCII(body.InstallationID, 1, 128) {
		fail(w, 400, "invalid installation ID")
		return
	}
	if !s.allowed("collector-register:"+a.ID, 60, time.Hour) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "collector registration rate limited")
		return
	}
	tx, err := s.Store.DB.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 503, "collector registration unavailable")
		return
	}
	defer tx.Rollback()
	var valid int
	if err = tx.QueryRow(`SELECT COUNT(*) FROM account_sessions WHERE token_hash=? AND user_id=? AND expires_at>?`, a.TokenHash, a.ID, time.Now().UnixMilli()).Scan(&valid); err != nil || valid != 1 {
		fail(w, 401, "login required")
		return
	}
	var source string
	err = tx.QueryRow(`SELECT source_id FROM account_collectors WHERE user_id=? AND device_id=?`, a.ID, body.InstallationID).Scan(&source)
	newSource := err == sql.ErrNoRows
	if newSource {
		source = "account-" + store.ID()
	}
	mac := hmac.New(sha256.New, s.accounts.collectorKey)
	mac.Write([]byte(a.TokenHash))
	mac.Write([]byte(source))
	token := hex.EncodeToString(mac.Sum(nil)[:18])
	if newSource {
		var result sql.Result
		result, err = tx.Exec(`INSERT INTO collectors(source_id,label,token_hash,revoked,created_at)
   SELECT ?,?,?,0,? WHERE (SELECT COUNT(*) FROM account_collectors WHERE user_id=?) < 20`,
			source, a.Username, store.Hash(token), time.Now().UnixMilli(), a.ID)
		if err == nil {
			if n, _ := result.RowsAffected(); n != 1 {
				fail(w, 429, "too many registered devices")
				return
			}
			_, err = tx.Exec(`INSERT INTO account_collectors VALUES(?,?,?,?,?)`, source, a.ID, body.InstallationID, a.TokenHash, a.Region)
		}
	} else if err == nil {
		var result sql.Result
		result, err = tx.Exec(`UPDATE collectors SET token_hash=? WHERE source_id=? AND revoked=0`, store.Hash(token), source)
		if err == nil {
			if n, _ := result.RowsAffected(); n != 1 {
				fail(w, 403, "collector revoked")
				return
			}
			_, err = tx.Exec(`UPDATE account_collectors SET session_hash=? WHERE source_id=?`, a.TokenHash, source)
		}
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 503, "collector registration unavailable")
		return
	}
	jsonOut(w, 201, map[string]string{"sourceId": source, "token": token})
}

const accountSourceQuery = `SELECT c.source_id FROM collectors c
  JOIN account_collectors a ON a.source_id=c.source_id
  JOIN accounts u ON u.id=a.user_id AND u.region=a.region
  JOIN account_sessions t ON t.token_hash=a.session_hash AND t.user_id=a.user_id
  WHERE c.token_hash=? AND c.revoked=0 AND t.expires_at>? AND a.region=?`

func (s *Server) authenticatedAccountSource(r *http.Request, token string) (string, error) {
	var source string
	err := s.Store.DB.QueryRowContext(r.Context(), accountSourceQuery,
		store.Hash(token), time.Now().UnixMilli(), supportedRegion).Scan(&source)
	return source, err
}

func (s *Server) accountCollectorLease(w http.ResponseWriter, r *http.Request) {
	if !s.allowed("collector-lease:"+s.clientIP(r), 240, time.Minute) {
		fail(w, 429, "rate limited")
		return
	}
	source, err := s.authSource(r)
	if err != nil {
		fail(w, 401, "invalid collector credential")
		return
	}
	var body leaseAction
	if !decode(w, r, &body, 256) {
		return
	}
	switch body.Action {
	case "acquire", "renew":
		if !s.collectorLease(w, source) {
			return
		}
	case "release":
		s.mu.Lock()
		delete(s.activeCollectors, source)
		s.mu.Unlock()
	default:
		fail(w, 400, "invalid action")
		return
	}
	jsonOut(w, 200, map[string]bool{"ok": true})
}

func (s *Server) releaseInvalidCollectors() {
	s.mu.Lock()
	var ids []string
	for id := range s.activeCollectors {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	if len(ids) == 0 {
		return
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := []any{time.Now().UnixMilli()}
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.Store.DB.Query(`SELECT a.source_id FROM account_collectors a
 JOIN collectors c ON c.source_id=a.source_id
 WHERE (c.revoked=1 OR NOT EXISTS (
 SELECT 1 FROM account_sessions s WHERE s.token_hash=a.session_hash AND s.user_id=a.user_id AND s.expires_at>?
 )) AND a.source_id IN (`+placeholders+`)`, args...)
	if err != nil {
		return
	}
	defer rows.Close()
	var invalid []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			invalid = append(invalid, id)
		}
	}
	rows.Close()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range invalid {
		delete(s.activeCollectors, id)
	}
}
