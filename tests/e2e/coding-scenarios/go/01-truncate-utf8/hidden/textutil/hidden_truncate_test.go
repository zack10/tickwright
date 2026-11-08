package textutil

import "testing"

func TestHiddenTruncateCountsCharacters(t *testing.T) {
	cases := map[string]struct {
		in   string
		n    int
		want string
	}{
		"accented name": {"Renée Dupont", 5, "Renée…"},
		"fits in characters, not bytes": {"café", 4, "café"},
		"non-latin": {"東京タワー展望台", 4, "東京タワ…"},
	}
	for name, c := range cases {
		if got := Truncate(c.in, c.n); got != c.want {
			t.Errorf("%s: Truncate(%q, %d) = %q, want %q", name, c.in, c.n, got, c.want)
		}
	}
}
