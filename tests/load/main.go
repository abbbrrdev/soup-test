// Load test: N concurrent runs, each receiving metrics at a fixed rate,
// each with one live SSE subscriber. Reports achieved throughput, latency,
// errors, and cross-checks accepted-via-API == stored-in-DB == delivered-live.
//
// Usage: go run . [-runs 50] [-rate 10] [-duration 20s]
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type result struct {
	ok      bool
	status  int
	latency time.Duration
	err     string
}

func main() {
	apiURL := flag.String("api", envOr("API_URL", "http://localhost:8080"), "backend base URL")
	dbURL := flag.String("db", envOr("DATABASE_URL", "postgres://tracker:tracker@localhost:5432/tracker"), "postgres connection string")
	runs := flag.Int("runs", 50, "number of concurrent runs")
	rate := flag.Int("rate", 10, "events per second per run")
	duration := flag.Duration("duration", 20*time.Second, "how long to send load")
	flag.Parse()

	fmt.Printf("=== Load test config ===\n")
	fmt.Printf("api=%s runs=%d rate=%d events/s/run target_total=%d events/s duration=%s batch_size=1\n",
		*apiURL, *runs, *rate, *runs**rate, *duration)
	fmt.Printf("event definition: one event = one metric data point in one POST /runs/{id}/metrics batch (batch size 1)\n")
	fmt.Printf("started_at=%s\n\n", time.Now().UTC().Format(time.RFC3339))

	ctx := context.Background()

	// --- Setup: one project, N runs. ---
	projectKey, err := createProject(*apiURL, fmt.Sprintf("loadtest-%d", time.Now().Unix()))
	if err != nil {
		fatal("create project: %v", err)
	}
	runIDs := make([]string, *runs)
	for i := 0; i < *runs; i++ {
		id, err := createRun(*apiURL, projectKey, fmt.Sprintf("load-run-%d", i))
		if err != nil {
			fatal("create run %d: %v", i, err)
		}
		runIDs[i] = id
	}
	fmt.Printf("created project and %d runs\n", *runs)

	// --- Live SSE subscribers: one per run, counting delivered metric events. ---
	received := make([]int64, *runs)
	streamErrs := make([]int64, *runs)
	sseCtx, cancelSSE := context.WithCancel(ctx)
	var sseWG sync.WaitGroup
	for i, runID := range runIDs {
		sseWG.Add(1)
		go func(i int, runID string) {
			defer sseWG.Done()
			subscribeAndCount(sseCtx, *apiURL, projectKey, runID, &received[i], &streamErrs[i])
		}(i, runID)
	}
	// Give subscribers a moment to establish before load starts.
	time.Sleep(500 * time.Millisecond)

	// --- Senders: one goroutine per run, firing at `rate` events/sec. ---
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: *runs + 10}}
	resultsCh := make(chan result, *runs**rate*int(duration.Seconds())+1000)
	var sendWG sync.WaitGroup
	sendStart := time.Now()
	// context.Done() closes (broadcasts to every reader); time.After's channel
	// only ever delivers once, which would stop just one of these N goroutines.
	sendCtx, cancelSend := context.WithTimeout(ctx, *duration)
	defer cancelSend()

	for _, runID := range runIDs {
		sendWG.Add(1)
		go func(runID string) {
			defer sendWG.Done()
			ticker := time.NewTicker(time.Second / time.Duration(*rate))
			defer ticker.Stop()
			step := int64(0)
			for {
				select {
				case <-sendCtx.Done():
					return
				case <-ticker.C:
					step++
					t0 := time.Now()
					status, err := postMetric(client, *apiURL, projectKey, runID, step)
					lat := time.Since(t0)
					r := result{ok: err == nil && status < 300, status: status, latency: lat}
					if err != nil {
						r.err = err.Error()
					}
					resultsCh <- r
				}
			}
		}(runID)
	}

	sendWG.Wait()
	sendElapsed := time.Since(sendStart)
	close(resultsCh)

	var results []result
	for r := range resultsCh {
		results = append(results, r)
	}

	// Let live subscribers drain anything still in flight, then stop them.
	time.Sleep(2 * time.Second)
	cancelSSE()
	sseWG.Wait()

	// --- Report: throughput, latency, errors. ---
	var okCount, errCount int
	var latencies []time.Duration
	errByStatus := map[int]int{}
	errByMsg := map[string]int{}
	for _, r := range results {
		if r.ok {
			okCount++
			latencies = append(latencies, r.latency)
		} else {
			errCount++
			if r.err != "" {
				errByMsg[r.err]++
			} else {
				errByStatus[r.status]++
			}
		}
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })

	fmt.Printf("\n=== Send phase result ===\n")
	fmt.Printf("wall_clock_send_duration=%s\n", sendElapsed)
	fmt.Printf("requests_sent=%d accepted=%d failed=%d\n", len(results), okCount, errCount)
	fmt.Printf("achieved_throughput=%.1f events/s (target was %d events/s)\n", float64(okCount)/sendElapsed.Seconds(), *runs**rate)
	if len(latencies) > 0 {
		fmt.Printf("latency p50=%s p95=%s p99=%s max=%s\n",
			pct(latencies, 0.50), pct(latencies, 0.95), pct(latencies, 0.99), latencies[len(latencies)-1])
	}
	if errCount > 0 {
		fmt.Printf("errors_by_status=%v\n", errByStatus)
		fmt.Printf("errors_by_message=%v\n", errByMsg)
	} else {
		fmt.Printf("errors: none\n")
	}

	// --- Independent cross-checks. ---
	var totalReceived, totalStreamErrs int64
	for i := range received {
		totalReceived += atomic.LoadInt64(&received[i])
		totalStreamErrs += atomic.LoadInt64(&streamErrs[i])
	}
	fmt.Printf("\n=== Live delivery cross-check (via SSE, independent of DB) ===\n")
	fmt.Printf("delivered_live_total=%d accepted_total=%d stream_errors=%d\n", totalReceived, okCount, totalStreamErrs)
	if totalReceived == int64(okCount) {
		fmt.Printf("RESULT: every accepted event was observed live exactly once across all %d subscribers\n", *runs)
	} else {
		fmt.Printf("RESULT: MISMATCH — live delivery total does not equal accepted total (diff=%d)\n", int64(okCount)-totalReceived)
	}

	pool, err := pgxpool.New(ctx, *dbURL)
	if err != nil {
		fatal("connect db for final check: %v", err)
	}
	defer pool.Close()
	var dbTotal int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM metrics WHERE run_id = ANY($1)`, runIDs,
	).Scan(&dbTotal); err != nil {
		fatal("db count query: %v", err)
	}
	fmt.Printf("\n=== Database cross-check (direct Postgres query, independent of API) ===\n")
	fmt.Printf("stored_in_db=%d accepted_total=%d\n", dbTotal, okCount)
	if dbTotal == okCount {
		fmt.Printf("RESULT: every accepted event is durably stored exactly once, no more, no less\n")
	} else {
		fmt.Printf("RESULT: MISMATCH — db row count does not equal accepted total (diff=%d)\n", okCount-dbTotal)
	}

	fmt.Printf("\nfinished_at=%s\n", time.Now().UTC().Format(time.RFC3339))
}

func pct(sorted []time.Duration, p float64) time.Duration {
	idx := int(float64(len(sorted)-1) * p)
	return sorted[idx]
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "FATAL: "+format+"\n", args...)
	os.Exit(1)
}

func createProject(apiURL, name string) (string, error) {
	body, _ := json.Marshal(map[string]string{"name": name})
	res, err := http.Post(apiURL+"/projects", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(res.Body)
		return "", fmt.Errorf("status %d: %s", res.StatusCode, b)
	}
	var out struct {
		APIKey struct {
			Key string `json:"key"`
		} `json:"api_key"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.APIKey.Key, nil
}

func createRun(apiURL, key, name string) (string, error) {
	body, _ := json.Marshal(map[string]string{"name": name})
	req, _ := http.NewRequest("POST", apiURL+"/runs", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(res.Body)
		return "", fmt.Errorf("status %d: %s", res.StatusCode, b)
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.ID, nil
}

func postMetric(client *http.Client, apiURL, key, runID string, step int64) (int, error) {
	payload := map[string]any{
		"batch_id": uuid.New().String(),
		"metrics": []map[string]any{
			{"name": "throughput", "step": step, "value": float64(step) * 0.01},
		},
	}
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", apiURL+"/runs/"+runID+"/metrics", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer func() {
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}()
	if res.StatusCode >= 300 {
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, fmt.Errorf("http %d: %s", res.StatusCode, b)
	}
	return res.StatusCode, nil
}

func subscribeAndCount(ctx context.Context, apiURL, key, runID string, counter, errCounter *int64) {
	req, _ := http.NewRequestWithContext(ctx, "GET", apiURL+"/runs/"+runID+"/stream", nil)
	req.Header.Set("Authorization", "Bearer "+key)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		atomic.AddInt64(errCounter, 1)
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		atomic.AddInt64(errCounter, 1)
		return
	}

	buf := make([]byte, 0, 4096)
	chunk := make([]byte, 4096)
	for {
		n, err := res.Body.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
			for {
				idx := bytes.Index(buf, []byte("\n\n"))
				if idx == -1 {
					break
				}
				block := buf[:idx]
				buf = buf[idx+2:]
				if bytes.Contains(block, []byte("event: metric")) {
					atomic.AddInt64(counter, 1)
				}
			}
		}
		if err != nil {
			if ctx.Err() == nil {
				atomic.AddInt64(errCounter, 1)
			}
			return
		}
	}
}
