package sse

import "testing"

func TestBroadcastEvictsFullSubscriber(t *testing.T) {
	h := NewHub()
	sub := h.Subscribe("run-1")

	for i := 0; i < subscriberBuffer; i++ {
		h.Broadcast("run-1", Event{ID: int64(i + 1), RunID: "run-1"})
	}

	h.Broadcast("run-1", Event{ID: int64(subscriberBuffer + 1), RunID: "run-1"})

	drained := 0
	for {
		_, ok := <-sub.Ch
		if !ok {
			break
		}
		drained++
	}
	if drained != subscriberBuffer {
		t.Fatalf("expected exactly %d buffered events before eviction, drained %d", subscriberBuffer, drained)
	}

	h.Broadcast("run-1", Event{ID: 999, RunID: "run-1"})
}

func TestUnsubscribeAfterEvictionIsSafe(t *testing.T) {
	h := NewHub()
	sub := h.Subscribe("run-2")
	for i := 0; i < subscriberBuffer+1; i++ {
		h.Broadcast("run-2", Event{ID: int64(i), RunID: "run-2"})
	}

	h.Unsubscribe(sub)
}

func TestSubscribersOnDifferentRunsAreIndependent(t *testing.T) {
	h := NewHub()
	subA := h.Subscribe("run-a")
	subB := h.Subscribe("run-b")

	h.Broadcast("run-a", Event{ID: 1, RunID: "run-a"})

	select {
	case ev := <-subA.Ch:
		if ev.ID != 1 {
			t.Fatalf("got wrong event id %d", ev.ID)
		}
	default:
		t.Fatalf("run-a subscriber did not receive its event")
	}

	select {
	case ev := <-subB.Ch:
		t.Fatalf("run-b subscriber must not see run-a's event, got %+v", ev)
	default:

	}
}
