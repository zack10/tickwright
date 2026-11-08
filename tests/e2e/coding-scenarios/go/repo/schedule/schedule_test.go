package schedule

import (
	"testing"
	"time"
)

var base = time.Date(2026, 3, 6, 2, 0, 0, 0, time.UTC)

func TestNextRunOnSchedule(t *testing.T) {
	now := base.Add(5 * time.Hour)
	if got, want := NextRun(base, 24*time.Hour, now), base.Add(24*time.Hour); !got.Equal(want) {
		t.Errorf("NextRun = %v, want %v", got, want)
	}
}

func TestDue(t *testing.T) {
	if Due(base, base.Add(-time.Minute)) {
		t.Error("not due before its time")
	}
	if !Due(base, base) {
		t.Error("due at its time")
	}
}
