package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"soup-tracker/backend/internal/sse"
)

const (
	maxMetricsPerBatch = 500
	maxMetricNameLen   = 128
)

var metricNameRe = regexp.MustCompile(`^[a-zA-Z0-9_./-]{1,128}$`)

func canonicalHash(metrics []MetricIn) string {
	var sb strings.Builder
	for _, m := range metrics {
		ts := ""
		if m.TS != nil {
			ts = *m.TS
		}
		fmt.Fprintf(&sb, "%s|%d|%s|%s\n", m.Name, m.Step, formatFloat(m.Value), ts)
	}
	sum := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(sum[:])
}

func formatFloat(f float64) string {
	return fmt.Sprintf("%.17g", f)
}

func validateBatch(b BatchIn) (string, error) {
	if _, err := uuid.Parse(b.BatchID); err != nil {
		return "batch_id must be a uuid", err
	}
	if len(b.Metrics) == 0 {
		return "metrics must not be empty", fmt.Errorf("empty")
	}
	if len(b.Metrics) > maxMetricsPerBatch {
		return fmt.Sprintf("metrics exceeds max batch size of %d", maxMetricsPerBatch), fmt.Errorf("too large")
	}
	for i, m := range b.Metrics {
		if !metricNameRe.MatchString(m.Name) {
			return fmt.Sprintf("metrics[%d].name invalid (1-%d chars, [a-zA-Z0-9_./-])", i, maxMetricNameLen), fmt.Errorf("bad name")
		}
		if m.Step < 0 {
			return fmt.Sprintf("metrics[%d].step must be >= 0", i), fmt.Errorf("bad step")
		}
		if math.IsNaN(m.Value) || math.IsInf(m.Value, 0) {
			return fmt.Sprintf("metrics[%d].value must be finite", i), fmt.Errorf("bad value")
		}
		if m.TS != nil {
			if _, err := time.Parse(time.RFC3339, *m.TS); err != nil {
				return fmt.Sprintf("metrics[%d].ts must be RFC3339", i), fmt.Errorf("bad ts")
			}
		}
	}
	return "", nil
}

func (s *Server) handleIngestMetrics(w http.ResponseWriter, r *http.Request) {
	run, ok := s.getOwnedRun(w, r)
	if !ok {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 256*1024)
	var batch BatchIn
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body (or batch exceeds 256KB)")
		return
	}
	if msg, err := validateBatch(batch); err != nil {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}

	hash := canonicalHash(batch.Metrics)
	ctx := r.Context()

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ingest failed")
		return
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, run.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "ingest failed")
		return
	}

	var inserted bool
	err = tx.QueryRow(ctx,
		`INSERT INTO batches (id, run_id, content_hash, metric_count)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (run_id, id) DO NOTHING
		 RETURNING true`,
		batch.BatchID, run.ID, hash, len(batch.Metrics),
	).Scan(&inserted)
	if err != nil {
		inserted = false
	}

	if inserted {
		inserted := make([]Metric, 0, len(batch.Metrics))
		for i, m := range batch.Metrics {
			ts := time.Now().UTC()
			if m.TS != nil {
				ts, _ = time.Parse(time.RFC3339, *m.TS)
			}
			var id int64
			if err := tx.QueryRow(ctx,
				`INSERT INTO metrics (run_id, batch_id, seq_in_batch, name, step, ts, value)
				 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
				run.ID, batch.BatchID, i, m.Name, m.Step, ts, m.Value,
			).Scan(&id); err != nil {
				writeErr(w, http.StatusInternalServerError, "ingest failed")
				return
			}
			inserted = append(inserted, Metric{ID: id, RunID: run.ID, BatchID: batch.BatchID, Name: m.Name, Step: m.Step, TS: ts, Value: m.Value})
		}
		if err := tx.Commit(ctx); err != nil {
			writeErr(w, http.StatusInternalServerError, "ingest failed")
			return
		}

		for _, m := range inserted {
			if payload, err := json.Marshal(m); err == nil {
				s.Hub.Broadcast(run.ID, sse.Event{ID: m.ID, RunID: run.ID, Payload: payload})
			}
		}
		writeJSON(w, http.StatusCreated, BatchResult{BatchID: batch.BatchID, Status: "accepted", MetricCount: len(batch.Metrics)})
		return
	}

	var existingHash string
	var existingCount int
	err = s.DB.QueryRow(ctx,
		`SELECT content_hash, metric_count FROM batches WHERE run_id = $1 AND id = $2`,
		run.ID, batch.BatchID,
	).Scan(&existingHash, &existingCount)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ingest failed")
		return
	}
	if existingHash == hash {
		writeJSON(w, http.StatusOK, BatchResult{BatchID: batch.BatchID, Status: "duplicate", MetricCount: existingCount})
		return
	}
	writeErr(w, http.StatusConflict, "batch_id already used with different content")
}

func (s *Server) handleGetMetrics(w http.ResponseWriter, r *http.Request) {
	run, ok := s.getOwnedRun(w, r)
	if !ok {
		return
	}
	rows, err := s.DB.Query(r.Context(),
		`SELECT id, run_id, batch_id, name, step, ts, value FROM metrics
		 WHERE run_id = $1 ORDER BY name, step, ts, id`,
		run.ID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to fetch metrics")
		return
	}
	defer rows.Close()

	metrics := []Metric{}
	for rows.Next() {
		var m Metric
		if err := rows.Scan(&m.ID, &m.RunID, &m.BatchID, &m.Name, &m.Step, &m.TS, &m.Value); err != nil {
			writeErr(w, http.StatusInternalServerError, "failed to fetch metrics")
			return
		}
		metrics = append(metrics, m)
	}
	writeJSON(w, http.StatusOK, metrics)
}
