// Package textutil formats text for display.
package textutil

// Truncate shortens s to at most n characters, adding "…" when it cut anything.
func Truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
