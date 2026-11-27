package httpapi

import (
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/xpanp/qqsg-fighting/backend/internal/store"
)

// A collector is an untrusted browser identity, never an authenticated player.
// The public endpoint returns an upload-only credential; administrator routes
// continue to require their independent HttpOnly cookie and CSRF token.
func (s *Server) registerCollector(w http.ResponseWriter, r *http.Request) {
	if !s.PublicRegistration || !s.sameOrigin(r) {
		fail(w, http.StatusForbidden, "collector_registration_unavailable")
		return
	}
	if mediaType := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])); mediaType != "application/json" {
		fail(w, http.StatusUnsupportedMediaType, "JSON required")
		return
	}
	if !s.allowed("register-ip:"+s.clientIP(r), 10, time.Hour) || !s.allowed("register-global", 100, time.Hour) {
		w.Header().Set("Retry-After", "3600")
		fail(w, http.StatusTooManyRequests, "collector_registration_rate_limited")
		return
	}
	var body struct{}
	if !decode(w, r, &body, 256) {
		return
	}
	if s.RegistrationLimit < 1 {
		fail(w, http.StatusForbidden, "collector_registration_unavailable")
		return
	}
	source, token := "browser-"+store.ID(), store.ID()
	// The count and insert are one SQL statement: concurrent callers cannot pass
	// the capacity check and overrun the limit. Revoked rows still count, so
	// registration cannot create unlimited historical source metadata.
	result, err := s.Store.DB.Exec(`INSERT INTO collectors(source_id,label,token_hash,revoked,created_at)
		SELECT ?,?,?,0,? WHERE (SELECT COUNT(*) FROM collectors) < ?`,
		source, "访客采集", store.Hash(token), time.Now().UnixMilli(), s.RegistrationLimit)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "collector_registration_unavailable")
		return
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		w.Header().Set("Retry-After", "3600")
		fail(w, http.StatusTooManyRequests, "collector_registration_capacity_full")
		return
	}
	jsonOut(w, http.StatusCreated, map[string]string{"sourceId": source, "token": token})
}

func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	// nginx overwrites X-Real-IP and is the only trusted production peer.
	// Never trust attacker-supplied forwarding headers on other connections.
	if !s.InsecureLocal && net.ParseIP(host).IsLoopback() {
		if forwarded := net.ParseIP(r.Header.Get("X-Real-IP")); forwarded != nil {
			host = forwarded.String()
		}
	}
	return host
}

// Admission is shared by /time and /ingest and guarded by one mutex. Waiting
// browsers keep their local queue; this capacity policy never stops capture.
func (s *Server) collectorLease(w http.ResponseWriter, source string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for id, expiry := range s.activeCollectors {
		if !expiry.After(now) {
			delete(s.activeCollectors, id)
		}
	}
	_, admitted := s.activeCollectors[source]
	if !admitted && len(s.activeCollectors) >= s.MaxActiveCollectors {
		w.Header().Set("Retry-After", "30")
		fail(w, http.StatusTooManyRequests, "upload_capacity_full")
		return false
	}
	s.activeCollectors[source] = now.Add(2 * time.Minute)
	return true
}
