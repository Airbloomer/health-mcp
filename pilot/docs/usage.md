# Usage attribution

D1 metrics are kept 31 days. Two UTC pulls run at `30 0 16 * *` and `30 0 1 * *`. Days 1-15 come from the day-16 pull. Days 16 through the end of the month come from the day-1 run. Merge keeps a day only from the pull that owns it. A value from the other pull is ignored, so the row does not depend on where the 31-day retention boundary falls. Workers queries are chunked by day.

The CSV columns are only:

`month, resource, requests, cpu, d1_rows_read, d1_rows_written, storage_bytes`

`cpu` is the sum of `cpuTimeUs`. `storage_bytes` stays empty until authenticated introspection confirms the storage aggregate. The query uses `databaseId` equality, one id at a time. It does not hardcode `databaseId_in` or a `max` block. Those two checks are TODOs in `pilot/src/usage.mjs`.

The read-only analytics token is the `pilot-analytics` environment secret. D1 analytics are counts only.

Reports under `pilot/reports/` are counts only. A check rejects any other CSV header.
