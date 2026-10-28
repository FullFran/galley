package comments

import (
	"sync"
	"time"
)

// maxBuckets bounds the limiter's memory; full idle buckets are dropped
// first, and everything when that is not enough.
const maxBuckets = 10_000

// RateLimiter is an in-memory token bucket per key (user id). It sits on top
// of PocketBase's own per-IP limiter and only covers comment writes.
type RateLimiter struct {
	burst float64
	every time.Duration
	clock Clock

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewRateLimiter allows burst writes at once and one more per every.
func NewRateLimiter(burst int, every time.Duration, clock Clock) *RateLimiter {
	if burst < 1 {
		burst = 1
	}
	if every <= 0 {
		every = time.Second
	}
	if clock == nil {
		clock = ClockFunc(time.Now)
	}
	return &RateLimiter{burst: float64(burst), every: every, clock: clock, buckets: map[string]*bucket{}}
}

// Allow takes one token from key's bucket and reports whether there was one.
func (l *RateLimiter) Allow(key string) bool {
	now := l.clock.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= maxBuckets {
			l.prune(now)
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	l.refill(b, now)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (l *RateLimiter) refill(b *bucket, now time.Time) {
	if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens = min(l.burst, b.tokens+float64(elapsed)/float64(l.every))
		b.last = now
	}
}

func (l *RateLimiter) prune(now time.Time) {
	for k, b := range l.buckets {
		l.refill(b, now)
		if b.tokens >= l.burst {
			delete(l.buckets, k)
		}
	}
	if len(l.buckets) >= maxBuckets {
		clear(l.buckets)
	}
}
