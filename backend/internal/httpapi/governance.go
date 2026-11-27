package httpapi

import (
	"database/sql"
	"net/http"
	"time"
)

func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Store.DB.QueryContext(r.Context(), `SELECT id,username,region,role,registered_at FROM accounts ORDER BY registered_at DESC,id`)
	if err != nil {
		fail(w, 503, "users unavailable")
		return
	}
	defer rows.Close()
	users := []account{}
	for rows.Next() {
		var a account
		if err := rows.Scan(&a.ID, &a.Username, &a.Region, &a.Role, &a.RegisteredAtMs); err != nil {
			fail(w, 503, "users unavailable")
			return
		}
		users = append(users, a)
	}
	if rows.Err() != nil {
		fail(w, 503, "users unavailable")
		return
	}
	rows.Close()
	jsonOut(w, 200, map[string]any{"users": users, "guestReports": s.guestEnabled()})
}
func (s *Server) changeRole(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Role string `json:"role"`
	}
	if !decode(w, r, &body, 256) {
		return
	}
	if body.Role != "ordinary" && body.Role != "super" {
		fail(w, 400, "invalid role")
		return
	}
	s.mutateAccount(w, r, body.Role)
}
func (s *Server) deleteAccount(w http.ResponseWriter, r *http.Request) { s.mutateAccount(w, r, "") }
func (s *Server) mutateAccount(w http.ResponseWriter, r *http.Request, role string) {
	target := r.PathValue("id")
	if target == systemAdmin {
		fail(w, 403, "system admin cannot be changed")
		return
	}
	tx, err := s.Store.DB.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 503, "user update unavailable")
		return
	}
	defer tx.Rollback()
	var result sql.Result
	action := "change_role:" + role
	if role == "" {
		action = "delete_user"
		result, err = tx.Exec(`DELETE FROM accounts WHERE id=?`, target)
	} else {
		result, err = tx.Exec(`UPDATE accounts SET role=? WHERE id=?`, role, target)
	}
	if err != nil {
		fail(w, 503, "user update unavailable")
		return
	}
	if n, _ := result.RowsAffected(); n != 1 {
		fail(w, 404, "user not found")
		return
	}
	rows, err := tx.Query(`SELECT token_hash FROM account_sessions WHERE user_id=?`, target)
	if err != nil {
		fail(w, 503, "user update unavailable")
		return
	}
	var sessions []string
	for rows.Next() {
		var token string
		if err = rows.Scan(&token); err != nil {
			break
		}
		sessions = append(sessions, token)
	}
	rows.Close()
	if err != nil || rows.Err() != nil {
		fail(w, 503, "user update unavailable")
		return
	}
	if _, err = tx.Exec(`DELETE FROM account_sessions WHERE user_id=?`, target); err == nil {
		_, err = tx.Exec(`INSERT INTO account_audit(actor,target,action,result,created_at)VALUES(?,?,?,'ok',?)`, accountActor(r), target, action, time.Now().UnixMilli())
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 503, "user update unavailable")
		return
	}
	for _, id := range sessions {
		s.releaseAccountView(id)
	}
	s.releaseInvalidCollectors()
	jsonOut(w, 200, map[string]bool{"ok": true})
}
func (s *Server) revealPassword(w http.ResponseWriter, r *http.Request) {
	target := r.PathValue("id")
	var ciphertext []byte
	var keyID string
	err := s.Store.DB.QueryRowContext(r.Context(), `SELECT password_ciphertext,password_key_id FROM accounts WHERE id=?`, target).Scan(&ciphertext, &keyID)
	size := s.accounts.encryption.NonceSize()
	status := 200
	var password []byte
	switch {
	case err == sql.ErrNoRows:
		status = 404
	case err != nil || keyID != s.accounts.keyID || len(ciphertext) < size:
		status = 503
	default:
		password, err = s.accounts.encryption.Open(nil, ciphertext[:size], ciphertext[size:], []byte(target))
		if err != nil {
			status = 503
		}
	}
	result := "denied"
	if status == 200 {
		result = "ok"
	}
	if _, err = s.Store.DB.Exec(`INSERT INTO account_audit(actor,target,action,result,created_at)VALUES(?,?,'reveal_password',?,?)`, accountActor(r), target, result, time.Now().UnixMilli()); err != nil {
		fail(w, 503, "password unavailable")
		return
	}
	if status != 200 {
		fail(w, status, "password unavailable")
		return
	}
	jsonOut(w, 200, map[string]string{"password": string(password)})
}
func (s *Server) changeGuestReports(w http.ResponseWriter, r *http.Request) {
	var body struct {
		GuestReports *bool `json:"guestReports"`
	}
	if !decode(w, r, &body, 256) {
		return
	}
	if body.GuestReports == nil {
		fail(w, 400, "guestReports required")
		return
	}
	tx, err := s.Store.DB.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 503, "settings unavailable")
		return
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE system_settings SET value=? WHERE key='guest_reports'`, *body.GuestReports); err == nil {
		_, err = tx.Exec(`INSERT INTO account_audit(actor,target,action,result,created_at)VALUES(?,'guest_reports','update_setting','ok',?)`, accountActor(r), time.Now().UnixMilli())
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 503, "settings unavailable")
		return
	}
	jsonOut(w, 200, map[string]bool{"guestReports": *body.GuestReports})
}
