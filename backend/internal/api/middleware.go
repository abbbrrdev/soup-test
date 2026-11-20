package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"soup-tracker/backend/internal/auth"
)

type ctxKey int

const (
	ctxProjectID ctxKey = iota
	ctxKeyID
)

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		token, ok := strings.CutPrefix(h, "Bearer ")
		if !ok || token == "" {
			writeErr(w, http.StatusUnauthorized, "missing or invalid authorization header")
			return
		}
		hash := auth.Hash(token)

		var projectID, keyID string
		err := s.DB.QueryRow(r.Context(),
			`SELECT project_id, id FROM api_keys WHERE key_hash = $1 AND is_active`,
			hash,
		).Scan(&projectID, &keyID)
		if err != nil {

			writeErr(w, http.StatusUnauthorized, "invalid api key")
			return
		}

		ctx := context.WithValue(r.Context(), ctxProjectID, projectID)
		ctx = context.WithValue(ctx, ctxKeyID, keyID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func projectIDFrom(ctx context.Context) string {
	v, _ := ctx.Value(ctxProjectID).(string)
	return v
}

func keyIDFrom(ctx context.Context) string {
	v, _ := ctx.Value(ctxKeyID).(string)
	return v
}

func isKeyActive(ctx context.Context, pool *pgxpool.Pool, keyID string) bool {
	var active bool
	err := pool.QueryRow(ctx, `SELECT is_active FROM api_keys WHERE id = $1`, keyID).Scan(&active)
	return err == nil && active
}

func noStoreMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}
