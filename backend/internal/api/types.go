package api

import "time"

type Project struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type APIKeyCreated struct {
	ID        string    `json:"id"`
	Key       string    `json:"key"`
	Prefix    string    `json:"prefix"`
	CreatedAt time.Time `json:"created_at"`
}

type Run struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

type MetricIn struct {
	Name  string  `json:"name"`
	Step  int64   `json:"step"`
	Value float64 `json:"value"`
	TS    *string `json:"ts,omitempty"`
}

type BatchIn struct {
	BatchID string     `json:"batch_id"`
	Metrics []MetricIn `json:"metrics"`
}

type BatchResult struct {
	BatchID     string `json:"batch_id"`
	Status      string `json:"status"`
	MetricCount int    `json:"metric_count"`
}

type Metric struct {
	ID      int64     `json:"id"`
	RunID   string    `json:"run_id"`
	BatchID string    `json:"batch_id"`
	Name    string    `json:"name"`
	Step    int64     `json:"step"`
	TS      time.Time `json:"ts"`
	Value   float64   `json:"value"`
}
