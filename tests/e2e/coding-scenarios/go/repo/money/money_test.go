package money

import "testing"

func TestParse(t *testing.T) {
	for in, want := range map[string]int64{"12.34": 1234, "7": 700, "0.5": 50} {
		got, err := Parse(in)
		if err != nil || got != want {
			t.Errorf("Parse(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"1.234", "", "abc"} {
		if _, err := Parse(in); err == nil {
			t.Errorf("Parse(%q) should fail", in)
		}
	}
}

func TestFormat(t *testing.T) {
	for in, want := range map[int64]string{1234: "12.34", 5: "0.05", 0: "0.00"} {
		if got := Format(in); got != want {
			t.Errorf("Format(%d) = %q, want %q", in, got, want)
		}
	}
}
