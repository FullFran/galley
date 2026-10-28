package reanchor

import (
	"container/list"
	"sync"
	"time"
)

// lru is a bounded, least-recently-used map from string keys to values or
// errors, bounded by entry count and, when size is set, by total bytes
// (maxBytes). An entry larger than maxBytes is not cached. An entry with a
// zero expiry never expires.
type lru[V any] struct {
	max      int
	maxBytes int64
	size     func(V) int64

	mu    sync.Mutex
	order *list.List // front = most recent; values are *entry[V]
	items map[string]*list.Element
	total int64
}

type entry[V any] struct {
	key  string
	val  V
	err  error
	exp  time.Time
	size int64
}

func newLRU[V any](max int, maxBytes int64, size func(V) int64) *lru[V] {
	return &lru[V]{max: max, maxBytes: maxBytes, size: size, order: list.New(), items: map[string]*list.Element{}}
}

// get returns the entry's value and error; ok is false when there is none
// or it expired.
func (c *lru[V]) get(key string, now time.Time) (v V, ok bool, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, found := c.items[key]
	if !found {
		return v, false, nil
	}
	e := el.Value.(*entry[V])
	if !e.exp.IsZero() && !now.Before(e.exp) {
		c.removeLocked(el)
		return v, false, nil
	}
	c.order.MoveToFront(el)
	return e.val, true, e.err
}

func (c *lru[V]) put(key string, v V, err error, exp time.Time) {
	var n int64
	if c.size != nil && err == nil {
		n = c.size(v)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, found := c.items[key]; found {
		c.removeLocked(el)
	}
	if c.maxBytes > 0 && n > c.maxBytes {
		return
	}
	c.items[key] = c.order.PushFront(&entry[V]{key: key, val: v, err: err, exp: exp, size: n})
	c.total += n
	for c.order.Len() > c.max || (c.maxBytes > 0 && c.total > c.maxBytes) {
		c.removeLocked(c.order.Back())
	}
}

func (c *lru[V]) removeLocked(el *list.Element) {
	e := el.Value.(*entry[V])
	c.order.Remove(el)
	delete(c.items, e.key)
	c.total -= e.size
}

func (c *lru[V]) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len()
}

func (c *lru[V]) bytes() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.total
}
