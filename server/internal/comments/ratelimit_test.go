package comments_test

import (
	"sync"
	"testing"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func TestRateLimiter(t *testing.T) {
	clock := newClock()
	rl := comments.NewRateLimiter(3, time.Second, clock)

	for i := range 3 {
		if !rl.Allow("alice") {
			t.Fatalf("write %d refused within the burst", i+1)
		}
	}
	if rl.Allow("alice") {
		t.Fatal("write beyond the burst allowed")
	}
	if !rl.Allow("bob") {
		t.Error("buckets are not per user")
	}

	clock.Advance(time.Second)
	if !rl.Allow("alice") {
		t.Error("token not refilled after one interval")
	}
	if rl.Allow("alice") {
		t.Error("refilled more than one token")
	}

	clock.Advance(time.Hour)
	for i := range 3 {
		if !rl.Allow("alice") {
			t.Fatalf("write %d refused after a long pause", i+1)
		}
	}
	if rl.Allow("alice") {
		t.Error("bucket grew beyond its capacity")
	}
}

func TestRateLimiterConcurrent(t *testing.T) {
	rl := comments.NewRateLimiter(50, time.Hour, newClock())
	var wg sync.WaitGroup
	var mu sync.Mutex
	allowed := 0
	for range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if rl.Allow("alice") {
				mu.Lock()
				allowed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if allowed != 50 {
		t.Errorf("allowed = %d, want 50", allowed)
	}
}
