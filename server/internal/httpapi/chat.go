package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/FullFran/galley/server/internal/chat"
	"github.com/FullFran/galley/server/internal/comments"
)

// Chat stream timing.
const (
	// DefaultChatHeartbeat keeps proxies from closing idle streams (Traefik
	// and most load balancers time out after 60 s or more).
	DefaultChatHeartbeat = 25 * time.Second
	// chatWriteTimeout drops a client that stops reading.
	chatWriteTimeout = 30 * time.Second
	// chatRetryMillis is the reconnect delay suggested to EventSource.
	chatRetryMillis = 5000
)

const maxChatBody = 32 << 10

// ChatStream is an open chat subscription; *chat.Subscription implements it.
type ChatStream interface {
	Backlog() []chat.Message
	Resync() bool
	Messages() <-chan chat.Message
	Done() <-chan struct{}
	Close()
}

// ChatService is what the chat handlers use; ChatAdapter wraps a
// *chat.Service.
type ChatService interface {
	History(ctx context.Context, a comments.Actor, repoID, beforeSeq int64, limit int) (chat.Page, error)
	Post(ctx context.Context, a comments.Actor, repoID int64, body string) (chat.Message, error)
	MarkRead(ctx context.Context, a comments.Actor, repoID, seq int64) (int64, error)
	Unread(ctx context.Context, a comments.Actor, repoID int64) (chat.Unread, error)
	Subscribe(ctx context.Context, a comments.Actor, repoID, afterSeq int64) (ChatStream, error)
	Check(ctx context.Context, a comments.Actor, repoID int64) error
}

type chatAdapter struct{ *chat.Service }

// Subscribe implements ChatService.
func (c chatAdapter) Subscribe(ctx context.Context, a comments.Actor, repoID, afterSeq int64) (ChatStream, error) {
	s, err := c.Service.Subscribe(ctx, a, repoID, afterSeq)
	if err != nil {
		return nil, err
	}
	return s, nil
}

// ChatAdapter adapts a *chat.Service to ChatService.
func ChatAdapter(s *chat.Service) ChatService { return chatAdapter{s} }

type chatHandlers struct{ Deps }

func registerChat(repos *router.RouterGroup[*core.RequestEvent], d Deps) {
	h := chatHandlers{d}
	repos.GET("/{repo_id}/chat", h.wrap(h.history))
	repos.POST("/{repo_id}/chat", h.wrap(h.post))
	repos.POST("/{repo_id}/chat/read", h.wrap(h.markRead))
	repos.GET("/{repo_id}/chat/unread", h.wrap(h.unread))
	repos.GET("/{repo_id}/chat/stream", withSession(d, h.stream))
}

func (h chatHandlers) wrap(fn actorHandler) func(*core.RequestEvent) error {
	return withSession(h.Deps, func(e *core.RequestEvent, a comments.Actor, _ string) error { return fn(e, a) })
}

type chatMessageJSON struct {
	ID        string     `json:"id"`
	RepoID    int64      `json:"repo_id"`
	Seq       int64      `json:"seq"`
	Author    authorJSON `json:"author"`
	Mine      bool       `json:"mine"`
	Body      string     `json:"body"`
	CreatedAt string     `json:"created_at"`
}

func toChatJSON(m chat.Message) chatMessageJSON {
	return chatMessageJSON{
		ID: m.ID, RepoID: m.RepoID, Seq: m.Seq, Author: authorJSON{Kind: string(comments.AuthorHuman), Login: m.AuthorLogin},
		Mine: m.Mine, Body: m.Body, CreatedAt: m.CreatedAt.UTC().Format(draftTime),
	}
}

func (h chatHandlers) history(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	q := e.Request.URL.Query()
	before, ok := intParam(q.Get("before_seq"))
	if !ok {
		return h.fail(e, &comments.ValidationError{Field: "before_seq"})
	}
	limit, ok := intParam(q.Get("limit"))
	if !ok || limit > chat.MaxPageSize {
		return h.fail(e, &comments.ValidationError{Field: "limit"})
	}
	page, err := h.Chat.History(e.Request.Context(), a, repoID, before, int(limit))
	if err != nil {
		return h.fail(e, err)
	}
	out := struct {
		Messages []chatMessageJSON `json:"messages"`
		HasMore  bool              `json:"has_more"`
	}{Messages: make([]chatMessageJSON, 0, len(page.Messages)), HasMore: page.HasMore}
	for _, m := range page.Messages {
		out.Messages = append(out.Messages, toChatJSON(m))
	}
	return e.JSON(http.StatusOK, out)
}

func (h chatHandlers) post(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	var in struct {
		Body string `json:"body"`
	}
	if status := decodeJSONLimit(e.Request, &in, maxChatBody); status != 0 {
		return errorJSON(e, status)
	}
	m, err := h.Chat.Post(e.Request.Context(), a, repoID, in.Body)
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusCreated, toChatJSON(m))
}

func (h chatHandlers) markRead(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	var in struct {
		Seq int64 `json:"seq"`
	}
	if status := decodeJSONLimit(e.Request, &in, 1<<10); status != 0 {
		return errorJSON(e, status)
	}
	seq, err := h.Chat.MarkRead(e.Request.Context(), a, repoID, in.Seq)
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusOK, map[string]int64{"last_read_seq": seq})
}

func (h chatHandlers) unread(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	u, err := h.Chat.Unread(e.Request.Context(), a, repoID)
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusOK, map[string]any{
		"repo_id": u.RepoID, "unread": u.Count, "last_read_seq": u.LastReadSeq, "latest_seq": u.LatestSeq,
	})
}

// stream serves the repository's new messages as Server-Sent Events. Each
// message is "id: <seq>", "event: message" and one JSON data line, flushed
// on its own; ": ping" heartbeats follow every ChatHeartbeat, and each
// heartbeat re-checks the session and the repository access, ending the
// stream when either is gone. A reconnecting EventSource sends Last-Event-ID
// and receives what it missed (or a "resync" event when that is too much).
func (h chatHandlers) stream(e *core.RequestEvent, a comments.Actor, session string) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	lastID := e.Request.Header.Get("Last-Event-ID")
	if lastID == "" {
		lastID = e.Request.URL.Query().Get("last_event_id")
	}
	after, ok := intParam(lastID)
	if !ok {
		return h.fail(e, &comments.ValidationError{Field: "last_event_id"})
	}
	ctx := e.Request.Context()
	sub, err := h.Chat.Subscribe(ctx, a, repoID, after)
	if err != nil {
		return h.fail(e, err)
	}
	defer sub.Close()

	w := e.Response
	rc := http.NewResponseController(w)
	hdr := w.Header()
	hdr.Set("Content-Type", "text/event-stream")
	hdr.Set("Cache-Control", "no-store")
	// Proxies such as nginx buffer responses unless told not to; Traefik
	// streams by default, and every event is flushed here anyway.
	hdr.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	// The request is fully read: lift the server read deadline (PocketBase
	// sets 5 minutes), which would otherwise cut the stream.
	_ = rc.SetReadDeadline(time.Time{})

	write := func(s string) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(chatWriteTimeout)) // unsupported on test recorders
		if _, err := io.WriteString(w, s); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	send := func(m chat.Message) bool {
		data, err := json.Marshal(toChatJSON(m))
		if err != nil {
			return false
		}
		return write("id: " + strconv.FormatInt(m.Seq, 10) + "\nevent: message\ndata: " + string(data) + "\n\n")
	}

	if !write("retry: " + strconv.Itoa(chatRetryMillis) + "\n\n") {
		return nil
	}
	if sub.Resync() && !write("event: resync\ndata: {}\n\n") {
		return nil
	}
	var last int64
	for _, m := range sub.Backlog() {
		if !send(m) {
			return nil
		}
		last = m.Seq
	}

	beat := h.ChatHeartbeat
	if beat <= 0 {
		beat = DefaultChatHeartbeat
	}
	ticker := time.NewTicker(beat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-sub.Done():
			write("event: close\ndata: {}\n\n")
			return nil
		case m := <-sub.Messages():
			if m.Seq <= last {
				continue // already sent from the backlog
			}
			if !send(m) {
				return nil
			}
		case <-ticker.C:
			if !h.stillAllowed(ctx, a, session, repoID) {
				write("event: close\ndata: {}\n\n")
				return nil
			}
			if !write(": ping\n\n") {
				return nil
			}
		}
	}
}

// stillAllowed fails closed: any error, transient or not, ends the stream
// and the client reconnects through the normal checks.
func (h chatHandlers) stillAllowed(ctx context.Context, a comments.Actor, session string, repoID int64) bool {
	u, err := h.Auth.Authenticate(ctx, session)
	if err != nil || u.ID != a.UserID {
		return false
	}
	return h.Chat.Check(ctx, a, repoID) == nil
}

func (h chatHandlers) fail(e *core.RequestEvent, err error) error {
	return failJSON(h.Deps, e, err, "chat")
}

// intParam parses an optional non-negative integer; "" is 0.
func intParam(s string) (int64, bool) {
	if s == "" {
		return 0, true
	}
	n, err := strconv.ParseInt(s, 10, 64)
	return n, err == nil && n >= 0
}
