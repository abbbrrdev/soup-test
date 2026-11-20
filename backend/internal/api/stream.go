package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

const heartbeatInterval = 3 * time.Second

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	run, ok := s.getOwnedRun(w, r)
	if !ok {
		return
	}
	keyID := keyIDFrom(r.Context())

	afterID := int64(0)
	if v := r.Header.Get("Last-Event-ID"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			afterID = n
		}
	} else if v := r.URL.Query().Get("after_id"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			afterID = n
		}
	}

	flusher, okF := w.(http.Flusher)
	if !okF {
		writeErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()

	sub := s.Hub.Subscribe(run.ID)
	defer s.Hub.Unsubscribe(sub)

	writeSSE := func(id int64, event string, payload []byte) bool {
		if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", id, event, payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	lastSent := afterID

	rows, err := s.DB.Query(ctx,
		`SELECT id, run_id, batch_id, name, step, ts, value FROM metrics
		 WHERE run_id = $1 AND id > $2 ORDER BY id`,
		run.ID, afterID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "stream failed")
		return
	}
	for rows.Next() {
		var m Metric
		if err := rows.Scan(&m.ID, &m.RunID, &m.BatchID, &m.Name, &m.Step, &m.TS, &m.Value); err != nil {
			rows.Close()
			return
		}
		payload, _ := json.Marshal(m)
		if !writeSSE(m.ID, "metric", payload) {
			rows.Close()
			return
		}
		lastSent = m.ID
	}
	rows.Close()

	if !writeSSE(lastSent, "ready", []byte(`{}`)) {
		return
	}

drain:
	for {
		select {
		case ev, chOk := <-sub.Ch:
			if !chOk {
				writeSSE(lastSent, "overflow", []byte(`{"reason":"slow_consumer"}`))
				return
			}
			if ev.ID > lastSent {
				if !writeSSE(ev.ID, "metric", ev.Payload) {
					return
				}
				lastSent = ev.ID
			}
		default:
			break drain
		}
	}

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, chOk := <-sub.Ch:
			if !chOk {
				writeSSE(lastSent, "overflow", []byte(`{"reason":"slow_consumer"}`))
				return
			}
			if ev.ID > lastSent {
				if !writeSSE(ev.ID, "metric", ev.Payload) {
					return
				}
				lastSent = ev.ID
			}
		case <-ticker.C:
			if !isKeyActive(ctx, s.DB, keyID) {
				writeSSE(lastSent, "revoked", []byte(`{}`))
				return
			}
			if !writeSSE(lastSent, "heartbeat", []byte(`{}`)) {
				return
			}
		}
	}
}
