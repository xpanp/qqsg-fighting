package httpapi

import (
	"github.com/xpanp/qqsg-fighting/backend/internal/store"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProxyLoginLimitsDoNotLockOtherClients(t *testing.T) {
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	api := New(db, "https://example.test", false)
	for i := 0; i < 11; i++ {
		r := httptest.NewRequest("POST", Prefix+"admin/login", strings.NewReader(`{"username":"nobody","password":"wrong"}`))
		r.RemoteAddr = "127.0.0.1:12345"
		r.Header.Set("Origin", api.Origin)
		r.Header.Set("X-Real-IP", "192.0.2.1")
		w := httptest.NewRecorder()
		api.Handler().ServeHTTP(w, r)
		if i == 10 && w.Code != 429 {
			t.Fatal("per-client rate limit missing", w.Code)
		}
	}
	r := httptest.NewRequest("POST", Prefix+"admin/login", strings.NewReader(`{"username":"nobody","password":"wrong"}`))
	r.RemoteAddr = "127.0.0.1:12345"
	r.Header.Set("Origin", api.Origin)
	r.Header.Set("X-Real-IP", "192.0.2.2")
	w := httptest.NewRecorder()
	api.Handler().ServeHTTP(w, r)
	if w.Code == 429 {
		t.Fatal("one proxy client locked every administrator")
	}
}
