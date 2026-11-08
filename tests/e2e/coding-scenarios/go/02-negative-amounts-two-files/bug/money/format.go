package money

import "fmt"

// Format writes cents as an amount with two decimals, e.g. 105 as "1.05".
func Format(cents int64) string {
	return fmt.Sprintf("%d.%02d", cents/100, cents%100)
}
