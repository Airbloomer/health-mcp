# Request limits

The free profile's raw input record cap is the constant `FREE_MAX_INPUT_RECORDS` in `src/core/limits.js`. Change that constant when a measurement says the cap should move. Do not copy the number into a second place.

That cap is **provisional**. A 750-record Health Connect webhook body was measured at 156,819 bytes, which is under the 262,144-byte JSON cap. CPU time for that payload has not been measured on Cloudflare. Local `wrangler dev --local` does not report or enforce CPU time.

## Measuring CPU time

Use a scratch Worker and an empty database. Do not point the measurement at a database that holds health data.

1. Deploy the scratch Worker with `HEALTH_LIMITS_PROFILE` unset, so the free profile is in effect.
2. Send two `POST /ingest/hc-webhook` bodies of `steps` records. Each record has `count`, `start_time`, `end_time`, and `metadata`. One body has 600 records across two local days. The other has 750 records on one local day.
3. In Workers analytics, read `cpuTime` for those two requests.
4. If the 750-record request does not fit the CPU budget, lower `FREE_MAX_INPUT_RECORDS` and repeat on the scratch Worker. Leave the 262,144-byte cap in place unless a fixture exceeds it.
