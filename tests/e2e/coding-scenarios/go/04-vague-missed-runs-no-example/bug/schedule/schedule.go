// Package schedule decides when recurring jobs run.
package schedule

import "time"

// NextRun returns when a job that runs every `every`, and last ran at `last`,
// runs next.
func NextRun(last time.Time, every time.Duration, now time.Time) time.Time {
	return last.Add(every)
}

// Due reports whether a job scheduled for next should run at now.
func Due(next, now time.Time) bool {
	return !now.Before(next)
}
