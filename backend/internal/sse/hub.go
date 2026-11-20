package sse

import "sync"

const subscriberBuffer = 256

type Event struct {
	ID      int64
	RunID   string
	Payload []byte
}

type Subscriber struct {
	Ch chan Event

	runID string
	hub   *Hub
}

type Hub struct {
	mu   sync.Mutex
	subs map[string]map[*Subscriber]struct{}
}

func NewHub() *Hub {
	return &Hub{subs: make(map[string]map[*Subscriber]struct{})}
}

func (h *Hub) Subscribe(runID string) *Subscriber {
	s := &Subscriber{Ch: make(chan Event, subscriberBuffer), runID: runID, hub: h}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.subs[runID] == nil {
		h.subs[runID] = make(map[*Subscriber]struct{})
	}
	h.subs[runID][s] = struct{}{}
	return s
}

func (h *Hub) Unsubscribe(s *Subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.subs[s.runID]; ok {
		delete(set, s)
		if len(set) == 0 {
			delete(h.subs, s.runID)
		}
	}
}

func (h *Hub) Broadcast(runID string, ev Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs[runID] {
		select {
		case s.Ch <- ev:
		default:
			close(s.Ch)
			delete(h.subs[runID], s)
		}
	}
	if len(h.subs[runID]) == 0 {
		delete(h.subs, runID)
	}
}
