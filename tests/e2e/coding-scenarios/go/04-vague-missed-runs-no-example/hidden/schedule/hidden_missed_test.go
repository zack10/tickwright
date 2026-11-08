package schedule

import (
	"testing"
	"time"
)

func TestHiddenMissedRunsAreSkipped(t *testing.T) {
	friday := time.Date(2026, 3, 6, 2, 0, 0, 0, time.UTC)
	monday := time.Date(2026, 3, 9, 9, 0, 0, 0, time.UTC)
	want := time.Date(2026, 3, 10, 2, 0, 0, 0, time.UTC)
	if got := NextRun(friday, 24*time.Hour, monday); !got.Equal(want) {
		t.Errorf("after a weekend down: NextRun = %v, want %v", got, want)
	}
	if got := NextRun(friday, time.Hour, friday.Add(30*time.Minute)); !got.Equal(friday.Add(time.Hour)) {
		t.Errorf("not yet due: NextRun = %v", got)
	}
}
