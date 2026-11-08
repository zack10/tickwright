// Package schedule decides when recurring jobs run.
package schedule

import "time"

// NextRun returns when a job that runs every `every`, and last ran at `last`,
// runs next: the first time on its schedule (last + k*every, k >= 1) that is
// after now. Runs missed while the service was down are skipped, not caught up.
func NextRun(last time.Time, every time.Duration, now time.Time) time.Time {
	next := last.Add(every)
	if !next.After(now) {
		missed := now.Sub(last) / every
		next = last.Add((missed + 1) * every)
	}
	return next
}

// Due reports whether a job scheduled for next should run at now.
func Due(next, now time.Time) bool {
	return !now.Before(next)
}
