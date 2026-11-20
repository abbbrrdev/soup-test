package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"soup-tracker/backend/internal/api"
	"soup-tracker/backend/internal/config"
	"soup-tracker/backend/internal/db"
	"soup-tracker/backend/internal/sse"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfg := config.Load()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := connectWithRetry(ctx, cfg.DatabaseURL, 15, 2*time.Second)
	if err != nil {
		slog.Error("failed to connect to database", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	hub := sse.NewHub()
	router := api.NewRouter(pool, hub)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("server starting", "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("graceful shutdown failed", "err", err)
	}
}

func connectWithRetry(ctx context.Context, url string, attempts int, delay time.Duration) (*pgxpool.Pool, error) {
	var lastErr error
	for i := 0; i < attempts; i++ {
		pool, err := db.NewPool(ctx, url)
		if err == nil {
			return pool, nil
		}
		lastErr = err
		slog.Warn("db not ready, retrying", "attempt", i+1, "err", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
	}
	return nil, lastErr
}
