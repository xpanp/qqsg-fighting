package httpapi

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"github.com/xpanp/qqsg-fighting/backend/internal/processing"
	"github.com/xpanp/qqsg-fighting/backend/internal/store"
	"golang.org/x/crypto/bcrypt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const Prefix = "/fighting/api/v1/"
const cookieName = "qqsg_admin"

type Server struct {
	Store         *store.Store
	Origin        string
	InsecureLocal bool
	Log           *slog.Logger
	mu            sync.Mutex
	limits        map[string]*bucket
	streams       int
}
type bucket struct {
	count int
	until time.Time
}

func New(s *store.Store, origin string, insecure bool) *Server {
	return &Server{Store: s, Origin: strings.TrimRight(origin, "/"), InsecureLocal: insecure, Log: slog.Default(), limits: map[string]*bucket{}}
}
func (s *Server) InitAdmin(password string) error {
	if len(password) < 12 || len(password) > 72 {
		return errors.New("admin password must be 12 to 72 bytes")
	}
	hash, e := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if e != nil {
		return e
	}
	tx, e := s.Store.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	_, e = tx.Exec(`INSERT INTO admins VALUES('admin',?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash`, hash)
	if e == nil {
		_, e = tx.Exec(`DELETE FROM sessions`)
	}
	if e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+Prefix+"ingest/batches", s.ingest)
	mux.HandleFunc("GET "+Prefix+"time", s.clock)
	mux.HandleFunc("POST "+Prefix+"admin/login", s.login)
	admin := http.NewServeMux()
	admin.HandleFunc("GET "+Prefix+"admin/session", s.session)
	admin.HandleFunc("POST "+Prefix+"admin/logout", s.logout)
	admin.HandleFunc("GET "+Prefix+"admin/events", s.events)
	admin.HandleFunc("GET "+Prefix+"admin/messages/{id}", s.message)
	admin.HandleFunc("GET "+Prefix+"admin/stats", s.stats)
	admin.HandleFunc("GET "+Prefix+"admin/name-configs", s.configs)
	admin.HandleFunc("POST "+Prefix+"admin/name-configs", s.saveConfig)
	admin.HandleFunc("GET "+Prefix+"admin/collector-credentials", s.collectors)
	admin.HandleFunc("POST "+Prefix+"admin/collector-credentials", s.collector)
	admin.HandleFunc("POST "+Prefix+"admin/event-overrides", s.override)
	admin.HandleFunc("POST "+Prefix+"admin/reprocess", s.reprocess)
	admin.HandleFunc("GET "+Prefix+"admin/jobs", s.jobs)
	admin.HandleFunc("POST "+Prefix+"admin/exports", s.export)
	admin.HandleFunc("GET "+Prefix+"admin/stream", s.stream)
	mux.Handle(Prefix+"admin/", s.requireAdmin(admin))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := store.ID()
		w.Header().Set("X-Request-ID", id)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		rw := &statusWriter{ResponseWriter: w}
		start := time.Now()
		defer func() {
			if v := recover(); v != nil {
				s.Log.Error("request panic", "requestId", id)
				fail(rw, 500, "internal error")
			}
			s.Log.Info("request", "requestId", id, "method", r.Method, "path", r.URL.Path, "status", rw.status, "elapsedMs", time.Since(start).Milliseconds())
		}()
		mux.ServeHTTP(rw, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
		w.ResponseWriter.WriteHeader(code)
	}
}
func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(b)
}
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (s *Server) allowed(key string, n int, d time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if len(s.limits) > 10000 {
		for k, b := range s.limits {
			if b.until.Before(now) {
				delete(s.limits, k)
			}
		}
		if len(s.limits) > 10000 {
			return false
		}
	}
	b := s.limits[key]
	if b == nil || b.until.Before(now) {
		s.limits[key] = &bucket{count: 1, until: now.Add(d)}
		return true
	}
	b.count++
	return b.count <= n
}
func jsonOut(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, code int, msg string) {
	jsonOut(w, code, map[string]string{"error": msg})
}
func decode(w http.ResponseWriter, r *http.Request, v any, max int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, max)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		fail(w, 400, "invalid request body")
		return false
	}
	var extra any
	if e := d.Decode(&extra); e != io.EOF {
		fail(w, 400, "one JSON object required")
		return false
	}
	return true
}
func (s *Server) sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o != "" {
		return o == s.Origin
	}
	ref := r.Header.Get("Referer")
	if ref != "" {
		u, e := url.Parse(ref)
		return e == nil && u.Scheme+"://"+u.Host == s.Origin
	}
	return false
}

type adminCtx struct{ Token, CSRF string }
type ctxKey struct{}

func (s *Server) getAdmin(r *http.Request) (adminCtx, error) {
	c, e := r.Cookie(cookieName)
	if e != nil {
		return adminCtx{}, e
	}
	if len(c.Value) != 36 {
		return adminCtx{}, errors.New("invalid cookie")
	}
	var csrf string
	e = s.Store.DB.QueryRow(`SELECT csrf FROM sessions WHERE token_hash=? AND expires_at>?`, store.Hash(c.Value), time.Now().UnixMilli()).Scan(&csrf)
	return adminCtx{Token: c.Value, CSRF: csrf}, e
}
func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a, e := s.getAdmin(r)
		if e != nil {
			fail(w, 401, "admin login required")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if !s.sameOrigin(r) || subtle.ConstantTimeCompare([]byte(a.CSRF), []byte(r.Header.Get("X-CSRF-Token"))) != 1 {
				fail(w, 403, "invalid CSRF token or origin")
				return
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, a)))
	})
}
func (s *Server) authSource(r *http.Request) (string, error) {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return "", errors.New("missing bearer")
	}
	token := strings.TrimPrefix(h, "Bearer ")
	if len(token) != 36 {
		return "", errors.New("invalid token")
	}
	var source string
	e := s.Store.DB.QueryRow(`SELECT source_id FROM collectors WHERE token_hash=? AND revoked=0`, store.Hash(token)).Scan(&source)
	return source, e
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(r) {
		fail(w, 403, "invalid origin")
		return
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	// The production listener is loopback-only and nginx overwrites this header.
	// Never trust forwarded IPs on a non-loopback connection or development listener.
	if !s.InsecureLocal && net.ParseIP(host).IsLoopback() {
		if forwarded := net.ParseIP(r.Header.Get("X-Real-IP")); forwarded != nil {
			host = forwarded.String()
		}
	}
	if !s.allowed("login:"+host, 10, 10*time.Minute) {
		fail(w, 429, "too many login attempts")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decode(w, r, &body, 4096) {
		return
	}
	var hash []byte
	e := s.Store.DB.QueryRow(`SELECT password_hash FROM admins WHERE username=?`, body.Username).Scan(&hash)
	if e != nil {
		hash = []byte("$2a$10$0t3gW5T3vCnxROsV1Zy2COj5tKD16puAwDxyZJALY2BeTQYd6jg7W")
	}
	valid := bcrypt.CompareHashAndPassword(hash, []byte(body.Password)) == nil
	if e != nil || !valid {
		fail(w, 401, "invalid login")
		return
	}
	token, csrf := store.ID(), store.ID()
	_, e = s.Store.DB.Exec(`DELETE FROM sessions WHERE expires_at<?`, time.Now().UnixMilli())
	if e == nil {
		_, e = s.Store.DB.Exec(`INSERT INTO sessions VALUES(?,?,?)`, store.Hash(token), csrf, time.Now().Add(12*time.Hour).UnixMilli())
	}
	if e != nil {
		fail(w, 500, "login unavailable")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: token, Path: "/fighting/api/", HttpOnly: true, Secure: !s.InsecureLocal, SameSite: http.SameSiteStrictMode, MaxAge: 43200})
	jsonOut(w, 200, map[string]string{"username": "admin", "csrfToken": csrf})
}
func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	a := r.Context().Value(ctxKey{}).(adminCtx)
	jsonOut(w, 200, map[string]string{"username": "admin", "csrfToken": a.CSRF})
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	a := r.Context().Value(ctxKey{}).(adminCtx)
	if _, e := s.Store.DB.Exec(`DELETE FROM sessions WHERE token_hash=?`, store.Hash(a.Token)); e != nil {
		fail(w, 500, "logout unavailable")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/fighting/api/", HttpOnly: true, Secure: !s.InsecureLocal, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	jsonOut(w, 200, map[string]bool{"ok": true})
}
func (s *Server) clock(w http.ResponseWriter, r *http.Request) {
	if _, e := s.authSource(r); e != nil {
		if _, e = s.getAdmin(r); e != nil {
			fail(w, 401, "credential required")
			return
		}
	}
	jsonOut(w, 200, map[string]int64{"serverTimeMs": time.Now().UnixMilli()})
}
func (s *Server) ingest(w http.ResponseWriter, r *http.Request) {
	source, e := s.authSource(r)
	if e != nil {
		fail(w, 401, "invalid collector credential")
		return
	}
	if !s.allowed("ingest:"+source, 120, time.Minute) {
		fail(w, 429, "rate limited")
		return
	}
	var b model.Batch
	if !decode(w, r, &b, 1<<20) {
		return
	}
	if b.SchemaVersion != 2 || b.BatchID == "" || len(b.BatchID) > 160 || b.SourceID != source || b.SessionID == "" || len(b.SessionID) > 160 || len(b.Messages) == 0 || len(b.Messages) > 100 || len(b.Context.Realm) > 120 || len(b.Context.Line) > 120 || math.IsNaN(b.Context.ClockOffsetMs) || math.IsNaN(b.Context.ClockUncertaintyMs) || math.Abs(b.Context.ClockOffsetMs) > 86400000 || b.Context.ClockUncertaintyMs < 0 || b.Context.ClockUncertaintyMs > 86400000 {
		fail(w, 400, "invalid batch or source")
		return
	}
	ack, e := s.Store.Ingest(b)
	if e != nil {
		if e.Error() == "session_context_conflict" {
			fail(w, 409, "session context changed")
		} else {
			s.Log.Error("ingest failed", "requestId", w.Header().Get("X-Request-ID"), "batchId", b.BatchID, "sourceId", source, "sessionId", b.SessionID)
			fail(w, 503, "ingest unavailable")
		}
		return
	}
	s.Log.Info("batch committed", "requestId", w.Header().Get("X-Request-ID"), "batchId", b.BatchID, "sourceId", source, "sessionId", b.SessionID, "jobId", ack.JobID, "accepted", len(ack.Accepted), "rejected", len(ack.Rejected))
	jsonOut(w, 200, ack)
}
func parseTime(s string, def int64) (int64, error) {
	if s == "" {
		return def, nil
	}
	if n, e := strconv.ParseInt(s, 10, 64); e == nil {
		return n, nil
	}
	t, e := time.Parse(time.RFC3339Nano, s)
	return t.UnixMilli(), e
}
func rangeQuery(r *http.Request) (int64, int64, error) {
	now := time.Now().UnixMilli()
	start, e := parseTime(r.URL.Query().Get("start"), now-3*3600000)
	if e != nil {
		return 0, 0, e
	}
	end, e := parseTime(r.URL.Query().Get("end"), now)
	if e != nil || start < 0 || end <= start || end-start > 31*24*3600000 {
		return 0, 0, errors.New("invalid time range")
	}
	return start, end, nil
}
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	start, end, e := rangeQuery(r)
	if e != nil {
		fail(w, 400, "invalid time range")
		return
	}
	limit := 200
	offset := 0
	if x := r.URL.Query().Get("limit"); x != "" {
		limit, _ = strconv.Atoi(x)
	}
	if x := r.URL.Query().Get("offset"); x != "" {
		offset, _ = strconv.Atoi(x)
	}
	if limit < 1 || limit > 1000 || offset < 0 {
		fail(w, 400, "invalid pagination")
		return
	}
	a, total, gen, e := s.Store.EventPage(start, end, limit, offset)
	if e != nil {
		fail(w, 503, "query unavailable; retry or choose a narrower time range")
		return
	}
	jsonOut(w, 200, map[string]any{"events": a, "total": total, "projectionVersion": gen})
}
func (s *Server) message(w http.ResponseWriter, r *http.Request) {
	ev, src, ovs, e := s.Store.Event(r.PathValue("id"))
	if e != nil {
		if e == sql.ErrNoRows {
			fail(w, 404, "event not found")
		} else {
			fail(w, 500, "query unavailable")
		}
		return
	}
	jsonOut(w, 200, map[string]any{"event": ev, "sources": src, "overrides": ovs})
}
func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	start, end, e := rangeQuery(r)
	if e != nil {
		fail(w, 400, "invalid time range")
		return
	}
	a, gen, e := s.Store.Events(start, end)
	if e != nil {
		if errors.Is(e, store.ErrQueryBudget) {
			fail(w, 413, e.Error())
			return
		}
		fail(w, 500, "query unavailable")
		return
	}
	jsonOut(w, 200, processing.Compute(a, start, end, gen))
}
func (s *Server) configs(w http.ResponseWriter, r *http.Request) {
	c, e := s.Store.Config()
	if e != nil {
		fail(w, 500, "config unavailable")
		return
	}
	v, e := s.Store.Configs()
	if e != nil {
		fail(w, 500, "config unavailable")
		return
	}
	jsonOut(w, 200, map[string]any{"active": c, "versions": v})
}
func (s *Server) saveConfig(w http.ResponseWriter, r *http.Request) {
	var c model.NameConfig
	if !decode(w, r, &c, 1<<20) {
		return
	}
	if len(c.NameA)+len(c.NameB)+len(c.NameOthers) > 10000 || len(c.Aliases) > 20000 || len(c.Blacklist) > 10000 {
		fail(w, 400, "config too large")
		return
	}
	if _, e := processing.NewResolver(c); e != nil {
		fail(w, 400, e.Error())
		return
	}
	id, job, e := s.Store.SaveConfig(c)
	if e != nil {
		fail(w, 500, "save config unavailable")
		return
	}
	jsonOut(w, 200, map[string]string{"id": id, "jobId": job})
}
func (s *Server) collectors(w http.ResponseWriter, r *http.Request) {
	rows, e := s.Store.DB.Query(`SELECT source_id,label,revoked FROM collectors ORDER BY created_at`)
	if e != nil {
		fail(w, 500, "query unavailable")
		return
	}
	defer rows.Close()
	a := []map[string]any{}
	for rows.Next() {
		var id, label string
		var revoked bool
		if e = rows.Scan(&id, &label, &revoked); e != nil {
			fail(w, 500, "query unavailable")
			return
		}
		a = append(a, map[string]any{"sourceId": id, "label": label, "revoked": revoked})
	}
	jsonOut(w, 200, map[string]any{"sources": a})
}
func (s *Server) collector(w http.ResponseWriter, r *http.Request) {
	var b struct {
		SourceID string `json:"sourceId"`
		Label    string `json:"label"`
		Revoke   bool   `json:"revoke"`
	}
	if !decode(w, r, &b, 4096) {
		return
	}
	if b.SourceID == "" {
		b.SourceID = store.ID()
	}
	if len(b.SourceID) > 160 || len(b.Label) > 200 {
		fail(w, 400, "invalid source")
		return
	}
	if b.Revoke {
		result, e := s.Store.DB.Exec(`UPDATE collectors SET revoked=1 WHERE source_id=?`, b.SourceID)
		if e != nil {
			fail(w, 500, "revoke unavailable")
			return
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			fail(w, 404, "source not found")
			return
		}
		jsonOut(w, 200, map[string]any{"sourceId": b.SourceID, "revoked": true})
		return
	}
	token := store.ID()
	_, e := s.Store.DB.Exec(`INSERT INTO collectors VALUES(?,?,?,0,?)`, b.SourceID, b.Label, store.Hash(token), time.Now().UnixMilli())
	if e != nil {
		fail(w, 409, "source already exists")
		return
	}
	jsonOut(w, 200, map[string]string{"sourceId": b.SourceID, "token": token})
}
func (s *Server) override(w http.ResponseWriter, r *http.Request) {
	var b struct {
		model.Override
		Excluded *bool `json:"excluded,omitempty"`
	}
	if !decode(w, r, &b, 16384) {
		return
	}
	if b.Excluded != nil {
		if *b.Excluded {
			b.Status = "excluded"
		} else {
			b.Status = "counted"
		}
	}
	if b.RequestID == "" || len(b.RequestID) > 160 || b.EventID == "" || len(b.Reason) < 1 || len(b.Reason) > 1000 || (b.Status != "" && b.Status != "counted" && b.Status != "excluded") || b.MergeInto == b.EventID {
		fail(w, 400, "invalid override")
		return
	}
	job, e := s.Store.SetOverride(b.Override)
	if e != nil {
		if e == sql.ErrNoRows {
			fail(w, 404, "event not found")
		} else {
			fail(w, 409, "override conflict")
		}
		return
	}
	jsonOut(w, 200, map[string]any{"ok": true, "jobId": job})
}
func (s *Server) reprocess(w http.ResponseWriter, r *http.Request) {
	var b struct{}
	if !decode(w, r, &b, 1024) {
		return
	}
	if !s.allowed("reprocess", 6, time.Minute) {
		fail(w, 429, "reprocess rate limited")
		return
	}
	id, e := s.Store.QueueFull()
	if e != nil {
		fail(w, 500, "queue unavailable")
		return
	}
	jsonOut(w, 200, map[string]string{"jobId": id})
}
func (s *Server) jobs(w http.ResponseWriter, r *http.Request) {
	a, e := s.Store.Jobs()
	if e != nil {
		fail(w, 500, "query unavailable")
		return
	}
	jsonOut(w, 200, map[string]any{"jobs": a})
}
func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Start             json.RawMessage `json:"start"`
		End               json.RawMessage `json:"end"`
		ProjectionVersion *int64          `json:"projectionVersion"`
	}
	if !decode(w, r, &b, 4096) {
		return
	}
	q := r.URL.Query()
	for key, raw := range map[string]json.RawMessage{"start": b.Start, "end": b.End} {
		if len(raw) > 0 && string(raw) != "null" {
			var v string
			if json.Unmarshal(raw, &v) != nil {
				v = string(raw)
			}
			q.Set(key, v)
		}
	}
	r.URL.RawQuery = q.Encode()
	start, end, e := rangeQuery(r)
	if e != nil {
		fail(w, 400, "invalid time range")
		return
	}
	a, gen, e := s.Store.Events(start, end)
	if e != nil {
		if errors.Is(e, store.ErrQueryBudget) {
			fail(w, 413, e.Error())
			return
		}
		fail(w, 500, "query unavailable")
		return
	}
	if b.ProjectionVersion != nil && *b.ProjectionVersion != gen {
		fail(w, 409, "projection changed; refresh before export")
		return
	}
	content, e := processing.Excel(processing.Compute(a, start, end, gen), a)
	if e != nil {
		fail(w, 500, "export unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="battle-report.xlsx"`)
	_, _ = w.Write(content)
}
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	if s.streams >= 8 {
		s.mu.Unlock()
		fail(w, 429, "too many streams")
		return
	}
	s.streams++
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.streams--; s.mu.Unlock() }()
	rc := http.NewResponseController(w)
	if e := rc.SetWriteDeadline(time.Now().Add(10 * time.Second)); e != nil {
		fail(w, 500, "stream deadline unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	last := int64(-1)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		if _, e := s.getAdmin(r); e != nil {
			return
		}
		gen := s.Store.Generation()
		if gen != last {
			_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
			_, e := fmt.Fprintf(w, "id: %d\nevent: update\ndata: {\"projectionVersion\":%d}\n\n", gen, gen)
			if e != nil {
				return
			}
			if e = rc.Flush(); e != nil {
				return
			}
			last = gen
		}
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
		case <-heartbeat.C:
			_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, e := io.WriteString(w, ": heartbeat\n\n"); e != nil {
				return
			}
			if e := rc.Flush(); e != nil {
				return
			}
		}
	}
}
func (s *Server) RunWorker(ctx context.Context) {
	timer := time.NewTicker(200 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			for {
				worked, e := s.Store.ProcessOne(ctx)
				if e != nil {
					if ctx.Err() != nil {
						return
					}
					s.Log.Error("processing job failed", "jobError", e.Error())
					break
				}
				if !worked {
					break
				}
				c, err := s.Store.Config()
				if err == nil {
					s.Log.Info("projection processed", "projectionVersion", s.Store.Generation(), "configVersion", c.ID)
				}
			}
		}
	}
}
