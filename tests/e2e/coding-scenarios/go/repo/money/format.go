package money

import "fmt"

// Format writes cents as an amount with two decimals, e.g. -105 as "-1.05".
func Format(cents int64) string {
	sign := ""
	if cents < 0 {
		sign = "-"
		cents = -cents
	}
	return fmt.Sprintf("%s%d.%02d", sign, cents/100, cents%100)
}
