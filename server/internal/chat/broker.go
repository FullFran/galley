package chat

import (
	"sync"

	"github.com/FullFran/galley/server/internal/comments"
)

// Subscription is one open chat stream. Messages delivers new messages of
// the repository; Done is closed when the stream must end (Close, user
// revocation, a full buffer, or shutdown). The channel from Messages is
// never closed, so readers select on both.
type Subscription struct {
	b       *broker
	userID  string
	repoID  int64
	ch      chan Message
	done    chan struct{}
	backlog []Message
	resync  bool
	closed  bool // guarded by b.mu
}

// Backlog hands over the messages after the subscriber's last seen sequence
// number, oldest first, read after the subscription was registered (so no
// message falls in between). It returns them once and then drops them, so a
// long-lived stream does not keep the replay in memory. Live messages may
// repeat its tail; skip those with a Seq not above the last backlog Seq.
// Call it from the goroutine that serves the stream.
func (s *Subscription) Backlog() []Message {
	b := s.backlog
	s.backlog = nil
	return b
}

// Resync reports that the backlog was truncated: the client should reload
// the history instead of trusting it.
func (s *Subscription) Resync() bool { return s.resync }

// Messages delivers live messages.
func (s *Subscription) Messages() <-chan Message { return s.ch }

// Done is closed when the stream must end.
func (s *Subscription) Done() <-chan struct{} { return s.done }

// Close unregisters the subscription. It is idempotent.
func (s *Subscription) Close() {
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	s.b.dropLocked(s)
}

// broker fans messages out to subscriptions in memory. Sends happen under
// mu and never block: a subscriber whose buffer is full is dropped and
// reconnects with Last-Event-ID.
type broker struct {
	perUser, total, buffer int

	mu       sync.Mutex
	byRepo   map[int64]map[*Subscription]struct{}
	byUser   map[string]map[*Subscription]struct{}
	count    int
	shutdown bool
}

func newBroker(perUser, total, buffer int) *broker {
	return &broker{
		perUser: perUser, total: total, buffer: buffer,
		byRepo: map[int64]map[*Subscription]struct{}{},
		byUser: map[string]map[*Subscription]struct{}{},
	}
}

func (b *broker) subscribe(userID string, repoID int64) (*Subscription, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.shutdown {
		return nil, comments.ErrUnavailable
	}
	if len(b.byUser[userID]) >= b.perUser || b.count >= b.total {
		return nil, ErrTooManyStreams
	}
	s := &Subscription{b: b, userID: userID, repoID: repoID, ch: make(chan Message, b.buffer), done: make(chan struct{})}
	add(b.byRepo, repoID, s)
	add(b.byUser, userID, s)
	b.count++
	return s, nil
}

// publish delivers m, rendered for each subscriber (Mine is per user).
func (b *broker) publish(m Message, authorID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for s := range b.byRepo[m.RepoID] {
		mm := m
		mm.Mine = s.userID == authorID
		select {
		case s.ch <- mm:
		default:
			b.dropLocked(s)
		}
	}
}

func (b *broker) closeUser(userID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for s := range b.byUser[userID] {
		b.dropLocked(s)
	}
}

func (b *broker) closeAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.shutdown = true
	for _, subs := range b.byUser {
		for s := range subs {
			b.dropLocked(s)
		}
	}
}

func (b *broker) dropLocked(s *Subscription) {
	if s.closed {
		return
	}
	s.closed = true
	close(s.done)
	remove(b.byRepo, s.repoID, s)
	remove(b.byUser, s.userID, s)
	b.count--
}

func add[K comparable](m map[K]map[*Subscription]struct{}, k K, s *Subscription) {
	if m[k] == nil {
		m[k] = map[*Subscription]struct{}{}
	}
	m[k][s] = struct{}{}
}

func remove[K comparable](m map[K]map[*Subscription]struct{}, k K, s *Subscription) {
	delete(m[k], s)
	if len(m[k]) == 0 {
		delete(m, k)
	}
}
