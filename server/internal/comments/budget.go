package comments

import (
	"context"
	"sync/atomic"
)

// ListWorkBudget is the re-anchoring work one listing may spend, in
// fuzzy-match cells (pattern runes times text runes).
const ListWorkBudget = 50_000_000

type budgetKey struct{}

// WithWorkBudget returns a context carrying a shared work budget of cells.
// Reanchorers spend it with SpendWork so a listing of many threads stays
// bounded; a context without a budget is unbounded (one thread).
func WithWorkBudget(ctx context.Context, cells int64) context.Context {
	b := new(atomic.Int64)
	b.Store(cells)
	return context.WithValue(ctx, budgetKey{}, b)
}

// WorkBudget reports the remaining budget and whether ctx has one.
func WorkBudget(ctx context.Context) (int64, bool) {
	b, ok := ctx.Value(budgetKey{}).(*atomic.Int64)
	if !ok {
		return 0, false
	}
	return b.Load(), true
}

// SpendWork takes cells from ctx's budget and reports whether they were
// available (always true without a budget). A refused spend takes nothing.
func SpendWork(ctx context.Context, cells int64) bool {
	b, ok := ctx.Value(budgetKey{}).(*atomic.Int64)
	if !ok {
		return true
	}
	for {
		left := b.Load()
		if left < cells {
			return false
		}
		if b.CompareAndSwap(left, left-cells) {
			return true
		}
	}
}
