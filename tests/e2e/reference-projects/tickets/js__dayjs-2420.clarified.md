# Timezone conversion drops the instance's locale

The timezone plugin builds new Day.js instances internally, and those instances lose the locale of the instance they came from. Everything done after or through a timezone conversion should keep the locale.

Expected:
- `tz()` keeps the locale. `dayjs('2020-01-08T15:14:59.741774+00:00').locale('es').tz('America/New_York').format('LLL')` gives `8 de enero de 2020 10:14`, the same as calling `.tz(...)` before `.locale('es')`. Today it gives `January 8, 2020 10:14 AM`.
- Operations on a timezone-aware instance that rebuild it internally keep the locale too, including everything the locale controls (for example the first day of the week).

Example, with the `timezone` plugin and `America/New_York`:

```
dayjs.tz('2023-02-17 00:00:00', 'America/New_York').startOf('week').format('YYYY-MM-DD')
-> 2023-02-12   (default locale, week starts on Sunday)

dayjs.tz('2023-02-17 00:00:00', 'America/New_York')
  .locale({ name: 'locale_test', weekStart: 3 })
  .startOf('week').format('YYYY-MM-DD')
-> 2023-02-15   (the locale's week starts on Wednesday)
```
