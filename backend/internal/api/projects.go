package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"soup-tracker/backend/internal/auth"
)

type createProjectReq struct {
	Name string `json:"name"`
}

type createProjectResp struct {
	Project Project       `json:"project"`
	APIKey  APIKeyCreated `json:"api_key"`
}

func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	var req createProjectReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 200 {
		writeErr(w, http.StatusBadRequest, "name must be 1-200 chars")
		return
	}

	plainKey, err := auth.GenerateKey()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "key generation failed")
		return
	}

	var p Project
	var k APIKeyCreated
	err = s.DB.QueryRow(r.Context(),
		`INSERT INTO projects (name) VALUES ($1) RETURNING id, name, created_at`,
		req.Name,
	).Scan(&p.ID, &p.Name, &p.CreatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to create project")
		return
	}

	err = s.DB.QueryRow(r.Context(),
		`INSERT INTO api_keys (project_id, key_hash, key_prefix) VALUES ($1, $2, $3)
		 RETURNING id, created_at`,
		p.ID, auth.Hash(plainKey), auth.Prefix(plainKey),
	).Scan(&k.ID, &k.CreatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to create api key")
		return
	}
	k.Key = plainKey
	k.Prefix = auth.Prefix(plainKey)

	writeJSON(w, http.StatusCreated, createProjectResp{Project: p, APIKey: k})
}

func (s *Server) handleGetMe(w http.ResponseWriter, r *http.Request) {
	projectID := projectIDFrom(r.Context())
	var p Project
	err := s.DB.QueryRow(r.Context(),
		`SELECT id, name, created_at FROM projects WHERE id = $1`, projectID,
	).Scan(&p.ID, &p.Name, &p.CreatedAt)
	if err != nil {
		notFound(w)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleRotateKey(w http.ResponseWriter, r *http.Request) {
	projectID := projectIDFrom(r.Context())
	oldKeyID := keyIDFrom(r.Context())

	plainKey, err := auth.GenerateKey()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "key generation failed")
		return
	}

	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "rotation failed")
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := tx.Exec(r.Context(),
		`UPDATE api_keys SET is_active = false, revoked_at = now() WHERE id = $1`, oldKeyID,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "rotation failed")
		return
	}

	var k APIKeyCreated
	err = tx.QueryRow(r.Context(),
		`INSERT INTO api_keys (project_id, key_hash, key_prefix) VALUES ($1, $2, $3)
		 RETURNING id, created_at`,
		projectID, auth.Hash(plainKey), auth.Prefix(plainKey),
	).Scan(&k.ID, &k.CreatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "rotation failed")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "rotation failed")
		return
	}

	k.Key = plainKey
	k.Prefix = auth.Prefix(plainKey)
	writeJSON(w, http.StatusOK, k)
}
