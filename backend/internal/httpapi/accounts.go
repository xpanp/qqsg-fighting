package httpapi

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/xpanp/qqsg-fighting/backend/internal/store"
	"golang.org/x/crypto/bcrypt"
)

const accountCookie = "qqsg_account"
const supportedRegion = "得陇望蜀"
const systemAdmin = "system-admin"
const leaseDuration = 120 * time.Second

type account struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	Region         string `json:"region"`
	Role           string `json:"role"`
	RegisteredAtMs int64  `json:"registeredAtMs"`
}
type accountSession struct {
	account
	TokenHash, CSRF string
}
type accountKey struct{}
type accountFeature struct {
	encryption                                    cipher.AEAD
	keyID                                         string
	collectorKey                                  []byte
	viewers                                       map[string]time.Time
	governance, privileged, viewerQueries, ingest chan struct{}
}

const accountSchema = `
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
 region TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('ordinary','super')), registered_at INTEGER NOT NULL,
 password_hash BLOB NOT NULL, password_ciphertext BLOB NOT NULL, password_key_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS account_sessions_user ON account_sessions(user_id);
CREATE TABLE IF NOT EXISTS account_collectors (source_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
 session_hash TEXT NOT NULL, region TEXT NOT NULL, UNIQUE(user_id,device_id));
CREATE TABLE IF NOT EXISTS system_settings(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
INSERT OR IGNORE INTO system_settings VALUES('guest_reports',1);
CREATE TABLE IF NOT EXISTS account_audit(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, target TEXT NOT NULL,
 action TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);
`

func (s *Server) EnableAccounts(key []byte) error {
	if len(key) != 32 {
		return errors.New("account password encryption key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	encryption, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	tx, err := s.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(accountSchema); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("qqsg-collector-v1"))
	s.accounts = &accountFeature{collectorKey: mac.Sum(nil), encryption: encryption, keyID: store.Hash(string(key))[:16], viewers: map[string]time.Time{},
		governance: make(chan struct{}, 4), privileged: make(chan struct{}, 4), viewerQueries: make(chan struct{}, 8), ingest: make(chan struct{}, 4)}
	return nil
}

func (s *Server) accountRoutes(mux, business *http.ServeMux) {
	mux.HandleFunc("GET "+Prefix+"auth/session", s.accountStatus)
	mux.HandleFunc("POST "+Prefix+"auth/login", s.accountLogin)
	mux.HandleFunc("POST "+Prefix+"auth/register", s.accountRegister)
	mux.HandleFunc("POST "+Prefix+"auth/guest", s.accountGuest)
	mux.HandleFunc("POST "+Prefix+"auth/logout", s.accountGuard("any", s.accountLogout))
	mux.HandleFunc("POST "+Prefix+"reports/lease", s.accountGuard("reports", s.reportLease))
	mux.HandleFunc("GET "+Prefix+"reports/events", s.accountGuard("view", s.events))
	mux.HandleFunc("GET "+Prefix+"reports/stats", s.accountGuard("view", s.stats))
	mux.HandleFunc("POST "+Prefix+"collectors/lease", s.accountCollectorLease)
	mux.HandleFunc("GET "+Prefix+"system/users", s.accountGuard("admin", s.listAccounts))
	mux.HandleFunc("PATCH "+Prefix+"system/users/{id}", s.accountGuard("admin", s.changeRole))
	mux.HandleFunc("DELETE "+Prefix+"system/users/{id}", s.accountGuard("admin", s.deleteAccount))
	mux.HandleFunc("POST "+Prefix+"system/users/{id}/password", s.accountGuard("admin", s.revealPassword))
	mux.HandleFunc("PATCH "+Prefix+"system/settings", s.accountGuard("admin", s.changeGuestReports))
	mux.HandleFunc("GET "+Prefix+"admin/stream", s.accountGuard("superStream", s.stream))
	mux.HandleFunc(Prefix+"admin/", s.accountGuard("super", business.ServeHTTP))
}

func (s *Server) sessionAccount(r *http.Request) (accountSession, error) {
	var a accountSession
	c, err := r.Cookie(accountCookie)
	if err != nil {
		return a, err
	}
	if len(c.Value) != 36 {
		return a, errors.New("invalid session")
	}
	a.TokenHash = store.Hash(c.Value)
	err = s.Store.DB.QueryRowContext(r.Context(), `
 SELECT t.user_id,t.csrf,COALESCE(u.username,CASE WHEN t.user_id=? THEN 'admin' ELSE '' END),
 COALESCE(u.region,''),COALESCE(u.role,CASE WHEN t.user_id=? THEN 'admin' ELSE 'guest' END),COALESCE(u.registered_at,0)
 FROM account_sessions t LEFT JOIN accounts u ON u.id=t.user_id
 WHERE t.token_hash=? AND t.expires_at>? AND (u.id IS NOT NULL OR t.user_id=? OR t.user_id='')
 `, systemAdmin, systemAdmin, a.TokenHash, time.Now().UnixMilli(), systemAdmin).Scan(&a.ID, &a.CSRF, &a.Username, &a.Region, &a.Role, &a.RegisteredAtMs)
	return a, err
}
func (s *Server) guestEnabled() bool {
	var enabled bool
	return s.Store.DB.QueryRow(`SELECT value FROM system_settings WHERE key='guest_reports'`).Scan(&enabled) == nil && enabled
}
func (s *Server) accountStatus(w http.ResponseWriter, r *http.Request) {
	a, err := s.sessionAccount(r)
	var user *account
	if err == nil {
		user = &a.account
	}
	jsonOut(w, 200, map[string]any{"user": user, "csrf": a.CSRF, "guestReports": s.guestEnabled(), "accountsEnabled": true})
}
func (s *Server) setAccountCookie(w http.ResponseWriter, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: accountCookie, Value: value, Path: "/fighting/api/", HttpOnly: true, Secure: !s.InsecureLocal, SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}
func (s *Server) beginAccountSession(w http.ResponseWriter, r *http.Request, a account, status int) {
	token, csrf := store.ID(), store.ID()
	tx, err := s.Store.DB.Begin()
	if err != nil {
		fail(w, 503, "login unavailable")
		return
	}
	defer tx.Rollback()
	previous, _ := r.Cookie(accountCookie)
	if previous != nil {
		if _, err = tx.Exec(`DELETE FROM account_sessions WHERE token_hash=?`, store.Hash(previous.Value)); err != nil {
			fail(w, 503, "login unavailable")
			return
		}
	}
	if _, err = tx.Exec(`DELETE FROM account_sessions WHERE expires_at<=?`, time.Now().UnixMilli()); err == nil {
		_, err = tx.Exec(`INSERT INTO account_sessions VALUES(?,?,?,?)`, store.Hash(token), a.ID, csrf, time.Now().Add(12*time.Hour).UnixMilli())
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 503, "login unavailable")
		return
	}
	if previous != nil {
		s.releaseAccountView(store.Hash(previous.Value))
		s.releaseInvalidCollectors()
	}
	s.setAccountCookie(w, token, 43200)
	jsonOut(w, status, map[string]any{"user": a, "csrf": csrf, "guestReports": s.guestEnabled(), "accountsEnabled": true})
}
func (s *Server) publicAccountRequest(w http.ResponseWriter, r *http.Request, operation string, limit int) bool {
	if !s.sameOrigin(r) {
		fail(w, 403, "invalid origin")
		return false
	}
	if !s.allowed("account:"+operation+":"+s.clientIP(r), limit, time.Minute) ||
		!s.allowed("account:"+operation+":global", 200, time.Minute) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "too many requests")
		return false
	}
	return true
}

type accountInput struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Region   string `json:"region,omitempty"`
}

func isAccountASCII(value string, min, max int) bool {
	if len(value) < min || len(value) > max {
		return false
	}
	for i := range len(value) {
		if value[i] < 33 || value[i] > 126 {
			return false
		}
	}
	return true
}
func (s *Server) accountRegister(w http.ResponseWriter, r *http.Request) {
	if !s.publicAccountRequest(w, r, "register", 10) {
		return
	}
	var body accountInput
	if !decode(w, r, &body, 1024) {
		return
	}
	usernameKey := strings.ToLower(body.Username)
	if !isAccountASCII(body.Username, 4, 16) || !isAccountASCII(body.Password, 8, 18) || body.Region != supportedRegion || usernameKey == "admin" {
		fail(w, 400, "invalid username, password or region")
		return
	}
	a := account{ID: store.ID(), Username: body.Username, Region: body.Region, Role: "ordinary", RegisteredAtMs: time.Now().UnixMilli()}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		fail(w, 503, "registration unavailable")
		return
	}
	nonce := make([]byte, s.accounts.encryption.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		fail(w, 503, "registration unavailable")
		return
	}
	ciphertext := s.accounts.encryption.Seal(nonce, nonce, []byte(body.Password), []byte(a.ID))
	result, err := s.Store.DB.Exec(`INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(username_key) DO NOTHING`, a.ID, a.Username, usernameKey, a.Region, a.Role, a.RegisteredAtMs, hash, ciphertext, s.accounts.keyID)
	if err != nil {
		fail(w, 503, "registration unavailable")
		return
	}
	if n, _ := result.RowsAffected(); n != 1 {
		fail(w, 409, "username already exists")
		return
	}
	s.beginAccountSession(w, r, a, 201)
}
func (s *Server) accountLogin(w http.ResponseWriter, r *http.Request) {
	if !s.publicAccountRequest(w, r, "login", 10) {
		return
	}
	var body accountInput
	if !decode(w, r, &body, 1024) {
		return
	}
	key := strings.ToLower(body.Username)
	var hash []byte
	var err error
	a := account{}
	if key == "admin" {
		a = account{ID: systemAdmin, Username: "admin", Role: "admin"}
		err = s.Store.DB.QueryRow(`SELECT password_hash FROM admins WHERE username='admin'`).Scan(&hash)
	} else {
		err = s.Store.DB.QueryRow(`SELECT id,username,region,role,registered_at,password_hash FROM accounts WHERE username_key=?`, key).Scan(&a.ID, &a.Username, &a.Region, &a.Role, &a.RegisteredAtMs, &hash)
	}
	if err != nil {
		hash = []byte("$2a$10$0t3gW5T3vCnxROsV1Zy2COj5tKD16puAwDxyZJALY2BeTQYd6jg7W")
	}
	valid := bcrypt.CompareHashAndPassword(hash, []byte(body.Password)) == nil
	if err != nil || !valid {
		fail(w, 401, "invalid login")
		return
	}
	s.beginAccountSession(w, r, a, 200)
}
func (s *Server) accountGuest(w http.ResponseWriter, r *http.Request) {
	if !s.publicAccountRequest(w, r, "guest", 30) {
		return
	}
	if !s.guestEnabled() {
		fail(w, 403, "guest reports disabled")
		return
	}
	if a, err := s.sessionAccount(r); err == nil && a.Role == "guest" {
		s.accountStatus(w, r)
		return
	}
	s.beginAccountSession(w, r, account{Role: "guest"}, 200)
}
func (s *Server) accountLogout(w http.ResponseWriter, r *http.Request) {
	a := r.Context().Value(accountKey{}).(accountSession)
	if _, err := s.Store.DB.Exec(`DELETE FROM account_sessions WHERE token_hash=?`, a.TokenHash); err != nil {
		fail(w, 503, "logout unavailable")
		return
	}
	s.releaseAccountView(a.TokenHash)
	s.releaseInvalidCollectors()
	s.setAccountCookie(w, "", -1)
	jsonOut(w, 200, map[string]bool{"ok": true})
}
func (s *Server) accountGuard(capability string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.allowed("account-api:"+capability+":"+s.clientIP(r), 600, time.Minute) {
			fail(w, 429, "rate limited")
			return
		}
		a, err := s.sessionAccount(r)
		if err != nil {
			fail(w, 401, "login required")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && (!s.sameOrigin(r) || subtle.ConstantTimeCompare([]byte(a.CSRF), []byte(r.Header.Get("X-CSRF-Token"))) != 1) {
			fail(w, 403, "invalid CSRF token or origin")
			return
		}
		var allowed bool
		var slots chan struct{}
		switch capability {
		case "any":
			allowed = true
		case "admin":
			allowed = a.Role == "admin"
			slots = s.accounts.governance
		case "super":
			allowed = a.Role == "super"
			slots = s.accounts.privileged
		case "superStream":
			allowed = a.Role == "super"
		case "collector":
			allowed = a.Role == "super" || a.Role == "ordinary"
		case "reports", "view":
			allowed = a.Role == "super" || a.Role == "ordinary" || (a.Role == "guest" && s.guestEnabled())
			if capability == "view" {
				slots = s.accounts.viewerQueries
				if a.Role == "super" {
					slots = s.accounts.privileged
				} else if allowed && !s.hasAccountView(a.TokenHash) {
					fail(w, 429, "viewer_lease_required")
					return
				}
			}
		}
		if !allowed {
			fail(w, 403, "insufficient permissions")
			return
		}
		if slots != nil {
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			default:
				w.Header().Set("Retry-After", "2")
				fail(w, 503, "request capacity full")
				return
			}
		}
		ctx := context.WithValue(r.Context(), accountKey{}, a)
		ctx = context.WithValue(ctx, ctxKey{}, adminCtx{CSRF: a.CSRF})
		next(w, r.WithContext(ctx))
	}
}
func accountActor(r *http.Request) string {
	if a, ok := r.Context().Value(accountKey{}).(accountSession); ok {
		return a.ID
	}
	return "admin"
}
func (s *Server) hasAccountView(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.accounts.viewers[id].After(time.Now())
}
func (s *Server) releaseAccountView(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.accounts.viewers, id)
}

type leaseAction struct {
	Action string `json:"action"`
}

func (s *Server) reportLease(w http.ResponseWriter, r *http.Request) {
	a := r.Context().Value(accountKey{}).(accountSession)
	var body leaseAction
	if !decode(w, r, &body, 256) {
		return
	}
	switch body.Action {
	case "release":
		s.releaseAccountView(a.TokenHash)
		jsonOut(w, 200, map[string]bool{"ok": true})
	case "acquire", "renew":
		if a.Role != "super" {
			s.mu.Lock()
			now := time.Now()
			for id, expiry := range s.accounts.viewers {
				if !expiry.After(now) {
					delete(s.accounts.viewers, id)
				}
			}
			_, admitted := s.accounts.viewers[a.TokenHash]
			full := !admitted && len(s.accounts.viewers) >= s.MaxViewers
			if !full {
				s.accounts.viewers[a.TokenHash] = now.Add(leaseDuration)
			}
			s.mu.Unlock()
			if full {
				w.Header().Set("Retry-After", "30")
				fail(w, 429, "viewer_capacity_full")
				return
			}
		}
		jsonOut(w, 200, map[string]bool{"ok": true})
	default:
		fail(w, 400, "invalid action")
	}
}
