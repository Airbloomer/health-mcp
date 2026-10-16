# Export runbook

Implemented in a later phase. This runbook is the procedure that phase must follow.

On request, export one tenant's D1 only (every table, health rows included). Do not include another tenant or any registry secret.

Preferred delivery: encrypt with `age` to a public key the user provides.

Fallback: a 7z archive with AES-256 and encrypted file names, plus a random passphrase of at least 20 characters. Send the passphrase on a different channel from the archive. Do not use the consent SMS thread for either.

After the user confirms receipt, or 7 days after delivery, whichever comes first, delete every local and intermediate copy (plaintext dump and encrypted file).

Record metadata-only events: `export_requested`, `export_delivered`, `export_operator_copy_deleted`.

Target for the export itself: 30 days.
