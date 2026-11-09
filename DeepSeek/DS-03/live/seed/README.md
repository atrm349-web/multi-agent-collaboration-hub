# duration-kit

Utility library for the reporting service.

## Task

Implement `parseDuration` in `src/duration.js`.

```js
parseDuration("90s")   // 90
parseDuration("1h30m") // 5400
```

### Rules (all of them are checked by the acceptance suite)

1. Units: `s`, `m`, `h`, `d`, `w` (seconds, minutes, hours, days, weeks).
2. A duration may combine units, e.g. `1h30m`, `2d4h`.
3. Units are **case-insensitive**: `1H30M` is valid.
4. Segments may be **separated by a single space**: `1h 30m` is valid (5400).
   But a space **between the number and its unit is invalid**: `1 h` must throw.
5. A bare number without a unit is invalid: `90` must throw.
6. Negative, decimal (`1.5h`), empty and unknown-unit input must throw
   `RangeError` whose `message` contains `INVALID_DURATION`.
7. Values that overflow a safe integer (`999999999999999999999s`) must also throw
   `RangeError` containing `INVALID_DURATION` (do not return `Infinity` or a
   lossy number).
8. Return the total number of seconds as an integer.
9. Keep `module.exports = { parseDuration }`.
