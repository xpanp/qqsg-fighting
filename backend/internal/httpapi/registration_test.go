package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xpanp/qqsg-fighting/backend/internal/store"
)

func registrationServer(t *testing.T) *Server {
	t.Helper()
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return New(db, "https://example.test", false)
}

func registrationRequest(api *Server, ip, origin, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", Prefix+"collectors/register", strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:12345"
	r.Header.Set("X-Real-IP", ip)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", origin)
	w := httptest.NewRecorder()
	api.Handler().ServeHTTP(w, r)
	return w
}

func registered(t *testing.T, api *Server) map[string]string {
	t.Helper()
	w := registrationRequest(api, "192.0.2.1", api.Origin, `{}`)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func bearerRequest(api *Server, path, token, body string) *httptest.ResponseRecorder {
	method := "GET"
	if body != "" {
		method = "POST"
	}
	r := httptest.NewRequest(method, Prefix+path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	r.RemoteAddr = "192.0.2.1:23456"
	w := httptest.NewRecorder()
	api.Handler().ServeHTTP(w, r)
	return w
}

func TestPublicRegistrationUploadOnlyRevocableCredential(t *testing.T) {
	api := registrationServer(t)
	v := registered(t, api)
	if !strings.HasPrefix(v["sourceId"], "browser-") || len(v["token"]) != 36 {
		t.Fatal("invalid independent credential")
	}
	var hash string
	if err := api.Store.DB.QueryRow(`SELECT token_hash FROM collectors WHERE source_id=?`, v["sourceId"]).Scan(&hash); err != nil || hash != store.Hash(v["token"]) {
		t.Fatal("token must be hashed at rest", err)
	}
	if w := bearerRequest(api, "time", v["token"], ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := bearerRequest(api, "admin/session", v["token"], ""); w.Code != 401 {
		t.Fatal("collector reached admin", w.Code)
	}
	now := time.Now().UnixMilli()
	body := fmt.Sprintf(`{"schemaVersion":2,"batchId":"b","sourceId":%q,"sessionId":"s","context":{"sessionStartedAtMs":%d,"realm":"得陇望蜀","line":"12","character":"东方小沅"},"messages":[{"id":"m","sessionId":"s","revision":1,"text":"[地图]甲在战斗中击败了乙","firstObservedAtMs":%d,"lastObservedAtMs":%d}]}`, v["sourceId"], now, now, now)
	if w := bearerRequest(api, "ingest/batches", v["token"], body); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := bearerRequest(api, "ingest/batches", v["token"], strings.Replace(body, "东方小沅", "另一角色", 1)); w.Code != 409 {
		t.Fatal("same session changed identity", w.Code, w.Body.String())
	}
	if _, err := api.Store.DB.Exec(`UPDATE collectors SET revoked=1 WHERE source_id=?`, v["sourceId"]); err != nil {
		t.Fatal(err)
	}
	if w := bearerRequest(api, "time", v["token"], ""); w.Code != 401 {
		t.Fatal("revoked token admitted", w.Code)
	}
}

func TestPublicRegistrationOriginJSONAndDisable(t *testing.T) {
	api := registrationServer(t)
	r := httptest.NewRequest("POST", Prefix+"collectors/register", strings.NewReader(`{}`))
	r.Header.Set("Origin", api.Origin)
	r.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	api.Handler().ServeHTTP(w, r)
	if w.Code != 415 {
		t.Fatal("non-JSON registration accepted", w.Code)
	}
	for _, origin := range []string{"https://attacker.test", ""} {
		if w := registrationRequest(api, "192.0.2.1", origin, `{}`); w.Code != 403 {
			t.Fatal(w.Code)
		}
	}
	if w := registrationRequest(api, "192.0.2.1", api.Origin, `{"sourceId":"admin"}`); w.Code != 400 {
		t.Fatal("client selected source", w.Code)
	}
	api.PublicRegistration = false
	if w := registrationRequest(api, "192.0.2.1", api.Origin, `{}`); w.Code != 403 {
		t.Fatal("disabled registration", w.Code)
	}
}

func TestPublicRegistrationRateAndCapacity(t *testing.T) {
	api := registrationServer(t)
	for i := 0; i < 11; i++ {
		w := registrationRequest(api, "192.0.2.1", api.Origin, `{}`)
		want := 201
		if i == 10 {
			want = 429
		}
		if w.Code != want {
			t.Fatal(i, w.Code, w.Body.String())
		}
	}
	if w := registrationRequest(api, "192.0.2.2", api.Origin, `{}`); w.Code != 201 {
		t.Fatal("one IP blocked all clients", w.Code)
	}
	api.RegistrationLimit = 11
	if _, err := api.Store.DB.Exec(`UPDATE collectors SET revoked=1`); err != nil {
		t.Fatal(err)
	}
	if w := registrationRequest(api, "192.0.2.3", api.Origin, `{}`); w.Code != 429 {
		t.Fatal("capacity not enforced", w.Code)
	}
}

func TestPublicRegistrationGlobalLimit(t *testing.T) {
	api := registrationServer(t)
	for i := 0; i < 101; i++ {
		w := registrationRequest(api, fmt.Sprintf("192.0.2.%d", i+1), api.Origin, `{}`)
		want := 201
		if i == 100 {
			want = 429
		}
		if w.Code != want {
			t.Fatal(i, w.Code, w.Body.String())
		}
	}
}

func TestPublicRegistrationConcurrentCapacity(t *testing.T) {
	api := registrationServer(t)
	api.RegistrationLimit = 3
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w := registrationRequest(api, fmt.Sprintf("192.0.2.%d", i+1), api.Origin, `{}`)
			if w.Code != 201 && w.Code != 429 {
				t.Errorf("unexpected status %d", w.Code)
			}
		}(i)
	}
	wg.Wait()
	var count int
	if err := api.Store.DB.QueryRow(`SELECT COUNT(*) FROM collectors`).Scan(&count); err != nil || count != 3 {
		t.Fatal(count, err)
	}
}

func TestTenActiveUploadersLeaseRenewalAndExpiry(t *testing.T) {
	api := registrationServer(t)
	tokens := make([]string, 11)
	sources := make([]string, 11)
	for i := range tokens {
		tokens[i] = store.ID()
		sources[i] = store.ID()
		if _, err := api.Store.DB.Exec(`INSERT INTO collectors VALUES(?,?,?,0,?)`, sources[i], "test", store.Hash(tokens[i]), time.Now().UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 10; i++ {
		if w := bearerRequest(api, "time", tokens[i], ""); w.Code != 200 {
			t.Fatal(i, w.Code)
		}
	}
	if w := bearerRequest(api, "time", tokens[10], ""); w.Code != 429 || w.Header().Get("Retry-After") == "" || !strings.Contains(w.Body.String(), "upload_capacity_full") {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := bearerRequest(api, "time", tokens[0], ""); w.Code != 200 {
		t.Fatal("admitted source cannot renew", w.Code)
	}
	api.mu.Lock()
	api.activeCollectors[sources[0]] = time.Now().Add(-time.Second)
	api.mu.Unlock()
	if w := bearerRequest(api, "time", tokens[10], ""); w.Code != 200 {
		t.Fatal("expired lease not released", w.Code)
	}
	if len(api.activeCollectors) != 10 {
		t.Fatal("unbounded active leases", len(api.activeCollectors))
	}
	if w := bearerRequest(api, "time", store.ID(), ""); w.Code != 401 {
		t.Fatal("invalid source consumed admission", w.Code)
	}
}

func TestCollectorLeaseConcurrentAdmissionIsBounded(t *testing.T) {
	api := registrationServer(t)
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _ = api.collectorLease(httptest.NewRecorder(), store.ID()) }()
	}
	wg.Wait()
	if len(api.activeCollectors) != 10 {
		t.Fatal("concurrent admission exceeded bound", len(api.activeCollectors))
	}
}

func TestAdminRevocationImmediatelyReleasesCollectorLease(t *testing.T) {
	api := registrationServer(t)
	v := registered(t, api)
	if w := bearerRequest(api, "time", v["token"], ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	token, csrf := store.ID(), store.ID()
	if _, err := api.Store.DB.Exec(`INSERT INTO sessions VALUES(?,?,?)`, store.Hash(token), csrf, time.Now().Add(time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", Prefix+"admin/collector-credentials", strings.NewReader(fmt.Sprintf(`{"sourceId":%q,"revoke":true}`, v["sourceId"])))
	r.Header.Set("Origin", api.Origin)
	r.Header.Set("X-CSRF-Token", csrf)
	r.Header.Set("Cookie", cookieName+"="+token)
	w := httptest.NewRecorder()
	api.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, ok := api.activeCollectors[v["sourceId"]]; ok {
		t.Fatal("revoked source retained a lease")
	}
	if w := bearerRequest(api, "time", v["token"], ""); w.Code != 401 {
		t.Fatal("revoked collector admitted", w.Code)
	}
}

func TestClockRateLimitsBoundUnauthenticatedAndSingleSourceRequests(t *testing.T) {
	t.Run("per IP before authentication", func(t *testing.T) {
		api := registrationServer(t)
		for i := 0; i < 121; i++ {
			w := bearerRequest(api, "time", store.ID(), "")
			want := 401
			if i == 120 {
				want = 429
			}
			if w.Code != want {
				t.Fatal(i, w.Code, w.Body.String())
			}
		}
	})
	t.Run("global across IPs before authentication", func(t *testing.T) {
		api := registrationServer(t)
		for i := 0; i < 601; i++ {
			r := httptest.NewRequest("GET", Prefix+"time", nil)
			r.RemoteAddr = fmt.Sprintf("192.0.%d.%d:12345", i/200, i%200+1)
			w := httptest.NewRecorder()
			api.Handler().ServeHTTP(w, r)
			want := 401
			if i == 600 {
				want = 429
			}
			if w.Code != want {
				t.Fatal(i, w.Code, w.Body.String())
			}
		}
	})
	t.Run("per valid source", func(t *testing.T) {
		api := registrationServer(t)
		v := registered(t, api)
		for i := 0; i < 61; i++ {
			w := bearerRequest(api, "time", v["token"], "")
			want := 200
			if i == 60 {
				want = 429
			}
			if w.Code != want {
				t.Fatal(i, w.Code, w.Body.String())
			}
			if i == 60 && w.Header().Get("Retry-After") != "60" {
				t.Fatal("missing retry hint")
			}
		}
	})
}

func TestPublicCredentialResponsesAreNotCachedOrLogged(t *testing.T) {
	api := registrationServer(t)
	var logs bytes.Buffer
	api.Log = slog.New(slog.NewJSONHandler(&logs, nil))
	w := registrationRequest(api, "192.0.2.1", api.Origin, `{}`)
	if w.Code != 201 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("registration response cacheable", w.Code, w.Header())
	}
	var v map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	if w := bearerRequest(api, "time?token="+v["token"], v["token"], ""); w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("clock response cacheable", w.Code)
	}
	if strings.Contains(logs.String(), v["token"]) || strings.Contains(logs.String(), store.Hash(v["token"])) {
		t.Fatal("credential leaked into request logs")
	}
}
