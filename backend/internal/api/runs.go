package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type createRunReq struct {
	Name string `json:"name"`
}

func (s *Server) handleCreateRun(w http.ResponseWriter, r *http.Request) {
	projectID := projectIDFrom(r.Context())
	var req createRunReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 200 {
		writeErr(w, http.StatusBadRequest, "name must be 1-200 chars")
		return
	}

	var run Run
	err := s.DB.QueryRow(r.Context(),
		`INSERT INTO runs (project_id, name) VALUES ($1, $2)
		 RETURNING id, project_id, name, status, created_at`,
		projectID, req.Name,
	).Scan(&run.ID, &run.ProjectID, &run.Name, &run.Status, &run.CreatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to create run")
		return
	}
	writeJSON(w, http.StatusCreated, run)
}

func (s *Server) handleListRuns(w http.ResponseWriter, r *http.Request) {
	projectID := projectIDFrom(r.Context())
	rows, err := s.DB.Query(r.Context(),
		`SELECT id, project_id, name, status, created_at FROM runs
		 WHERE project_id = $1 ORDER BY created_at DESC`,
		projectID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to list runs")
		return
	}
	defer rows.Close()

	runs := []Run{}
	for rows.Next() {
		var run Run
		if err := rows.Scan(&run.ID, &run.ProjectID, &run.Name, &run.Status, &run.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "failed to list runs")
			return
		}
		runs = append(runs, run)
	}
	writeJSON(w, http.StatusOK, runs)
}

func (s *Server) getOwnedRun(w http.ResponseWriter, r *http.Request) (Run, bool) {
	projectID := projectIDFrom(r.Context())
	runID := chi.URLParam(r, "id")
	if _, err := uuid.Parse(runID); err != nil {

		notFound(w)
		return Run{}, false
	}
	var run Run
	err := s.DB.QueryRow(r.Context(),
		`SELECT id, project_id, name, status, created_at FROM runs
		 WHERE id = $1 AND project_id = $2`,
		runID, projectID,
	).Scan(&run.ID, &run.ProjectID, &run.Name, &run.Status, &run.CreatedAt)
	if err != nil {
		notFound(w)
		return Run{}, false
	}
	return run, true
}

func (s *Server) handleGetRun(w http.ResponseWriter, r *http.Request) {
	run, ok := s.getOwnedRun(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, run)
}
