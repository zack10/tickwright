package textutil

import "testing"

func TestTruncate(t *testing.T) {
	cases := map[string]struct {
		in   string
		n    int
		want string
	}{
		"short text is unchanged": {"hi", 5, "hi"},
		"long text is cut":        {"hello world", 5, "hello…"},
		"exact length":            {"hello", 5, "hello"},
	}
	for name, c := range cases {
		if got := Truncate(c.in, c.n); got != c.want {
			t.Errorf("%s: Truncate(%q, %d) = %q, want %q", name, c.in, c.n, got, c.want)
		}
	}
}
