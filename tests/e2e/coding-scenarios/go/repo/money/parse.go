// Package money handles amounts as integer cents.
package money

import (
	"fmt"
	"strconv"
	"strings"
)

// Parse reads an amount such as "12.34", "-1.05" or "7" into cents.
func Parse(s string) (int64, error) {
	negative := strings.HasPrefix(s, "-")
	whole, frac, _ := strings.Cut(strings.TrimPrefix(s, "-"), ".")
	if whole == "" || len(frac) > 2 {
		return 0, fmt.Errorf("money: invalid amount %q", s)
	}
	for len(frac) < 2 {
		frac += "0"
	}
	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("money: invalid amount %q", s)
	}
	f, err := strconv.ParseInt(frac, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("money: invalid amount %q", s)
	}
	cents := w*100 + f
	if negative {
		cents = -cents
	}
	return cents, nil
}
