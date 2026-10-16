# Request limits

The free profile's raw input record cap is one constant, `FREE_MAX_INPUT_RECORDS` in `src/core/limits.js`. That cap is PROVISIONAL. A Health Connect webhook body at this cap was measured at 156,819 bytes, under the 262,144-byte JSON cap.

Do not add a second copy of the number. When the measurement below says the cap should move, change `FREE_MAX_INPUT_RECORDS` only.

## Measuring CPU time

Use a scratch Worker and an empty database. Do not point the measurement at a database that holds health data. Leave `HEALTH_LIMITS_PROFILE` unset so the free profile is in effect.

Send three `POST /ingest/hc-webhook` bodies of `steps` records. Each record has `count`, `start_time`, `end_time`, and `metadata`.

1. 300 records on one local day.
2. 600 records across two local days.
3. 750 records on one local day.

In Workers analytics, read `cpuTime` for those requests. Record p50, p99, and max. On the `workersInvocationsAdaptive` dataset, p50 and p99 are the quantiles `cpuTimeP50` and `cpuTimeP99`. max is the maximum `cpuTime` for the same requests.

If CPU exceeds the budget, lower `FREE_MAX_INPUT_RECORDS` and repeat the three fixtures. Keep the 413 `retry` `split` path unchanged. Leave the 262,144-byte cap in place unless a fixture exceeds it.
