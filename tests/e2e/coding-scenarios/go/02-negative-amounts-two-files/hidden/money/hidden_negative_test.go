package money

import "testing"

func TestHiddenNegativeAmounts(t *testing.T) {
	for in, want := range map[string]int64{"-1.05": -105, "-0.50": -50, "-7": -700} {
		got, err := Parse(in)
		if err != nil || got != want {
			t.Errorf("Parse(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for in, want := range map[int64]string{-105: "-1.05", -5: "-0.05", -700: "-7.00"} {
		if got := Format(in); got != want {
			t.Errorf("Format(%d) = %q, want %q", in, got, want)
		}
	}
	for _, amount := range []string{"-12.34", "0.01", "-0.01"} {
		cents, err := Parse(amount)
		if err != nil || Format(cents) != amount {
			t.Errorf("%q does not round-trip: %d, %v -> %q", amount, cents, err, Format(cents))
		}
	}
}
