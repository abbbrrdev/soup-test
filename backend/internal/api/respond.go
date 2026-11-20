package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if v != nil {
		if err := json.NewEncoder(w).Encode(v); err != nil {
			slog.Error("encode response", "err", err)
		}
	}
}

type errBody struct {
	Error string `json:"error"`
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errBody{Error: msg})
}

func notFound(w http.ResponseWriter) {
	writeErr(w, http.StatusNotFound, "not found")
}
