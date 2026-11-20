package api

import (
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"soup-tracker/backend/internal/sse"
)

type Server struct {
	DB  *pgxpool.Pool
	Hub *sse.Hub
}

func NewRouter(db *pgxpool.Pool, hub *sse.Hub) http.Handler {
	s := &Server{DB: db, Hub: hub}

	r := chi.NewRouter()
	r.Use(corsMiddleware)
	r.Use(noStoreMiddleware)

	r.Get("/healthz", s.handleHealthz)
	r.Get("/readyz", s.handleReadyz)

	r.Post("/projects", s.handleCreateProject)

	r.Group(func(r chi.Router) {
		r.Use(s.authMiddleware)
		r.Get("/projects/me", s.handleGetMe)
		r.Post("/projects/me/keys/rotate", s.handleRotateKey)

		r.Post("/runs", s.handleCreateRun)
		r.Get("/runs", s.handleListRuns)
		r.Get("/runs/{id}", s.handleGetRun)
		r.Post("/runs/{id}/metrics", s.handleIngestMetrics)
		r.Get("/runs/{id}/metrics", s.handleGetMetrics)
		r.Get("/runs/{id}/stream", s.handleStream)
	})

	return r
}

func corsMiddleware(next http.Handler) http.Handler {
	allowOrigin := os.Getenv("CORS_ORIGIN")
	if allowOrigin == "" {
		allowOrigin = "*"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", allowOrigin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if err := s.DB.Ping(r.Context()); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "db not ready")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}
