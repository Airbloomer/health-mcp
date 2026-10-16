# Deletion notice

Health data for a tenant is fully deleted within 30 days of the request. That window covers D1 Time Travel retention (up to 30 days).

Deletion removes the tenant Worker, its secrets, and the whole tenant D1 database. It is not a row delete.

Whether deleting the database also purges Time Travel immediately is still an open question for the platform. Until that is answered, the 30-day window is what we tell users.

The consent ciphertext in the registry follows a different retention rule: the life of the account plus 3 years. See `pilot/registry/README.md`.
