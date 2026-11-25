package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/xpanp/qqsg-fighting/backend/internal/httpapi"
	"github.com/xpanp/qqsg-fighting/backend/internal/store"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	if e := run(); e != nil {
		slog.Error("server stopped", "error", e)
		os.Exit(1)
	}
}
func run() error {
	dir := flag.String("data-dir", "", "absolute runtime data directory")
	listen := flag.String("listen", "127.0.0.1:8780", "loopback listen address")
	origin := flag.String("origin", "https://jinbaofu.cn", "browser origin")
	insecure := flag.Bool("insecure-local", false, "allow HTTP cookie only on loopback development")
	initAdmin := flag.Bool("init-admin", false, "initialize admin from QQSG_ADMIN_PASSWORD and revoke sessions")
	backup := flag.String("backup", "", "consistent backup to an absolute new filename")
	importNames := flag.String("import-names", "", "import name_a/name_b/name_others/aliases/blacklist directory and exit")
	flag.Parse()
	if !filepath.IsAbs(*dir) {
		return fmt.Errorf("--data-dir must be absolute")
	}
	host, _, e := net.SplitHostPort(*listen)
	if e != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return fmt.Errorf("listen must be a loopback IP")
	}
	u, e := url.Parse(*origin)
	if e != nil || u.Host == "" || u.Path != "" || (u.Scheme != "https" && !(*insecure && u.Scheme == "http")) {
		return fmt.Errorf("invalid origin")
	}
	if *insecure {
		h := u.Hostname()
		if h != "localhost" && (net.ParseIP(h) == nil || !net.ParseIP(h).IsLoopback()) {
			return fmt.Errorf("insecure mode requires loopback origin")
		}
	}
	s, e := store.Open(*dir)
	if e != nil {
		return e
	}
	defer s.Close()
	api := httpapi.New(s, strings.TrimRight(*origin, "/"), *insecure)
	if *initAdmin {
		return api.InitAdmin(os.Getenv("QQSG_ADMIN_PASSWORD"))
	}
	if *backup != "" {
		return s.Backup(*backup)
	}
	if *importNames != "" {
		config, err := store.ReadNameFiles(*importNames)
		if err != nil {
			return err
		}
		id, job, err := s.SaveConfig(config)
		if err != nil {
			return err
		}
		slog.Info("name configuration imported", "configVersion", id, "jobId", job)
		return nil
	}
	var adminCount int
	if e = s.DB.QueryRow(`SELECT COUNT(*) FROM admins`).Scan(&adminCount); e != nil {
		return e
	}
	if adminCount == 0 {
		return fmt.Errorf("initialize admin before serving")
	}
	if e = s.PrepareWorker(); e != nil {
		return e
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go api.RunWorker(ctx)
	srv := &http.Server{Addr: *listen, Handler: api.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	slog.Info("server starting", "address", *listen)
	e = srv.ListenAndServe()
	if e == http.ErrServerClosed {
		return nil
	}
	return e
}
