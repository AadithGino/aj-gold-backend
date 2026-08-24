# Incident Response

## Readiness failure

1. Check `GET /api/health/ready` response reason
2. Verify MongoDB replica set and connectivity
3. Run `npm run migrate:verify` and `npm run verify:indexes`
4. Review structured logs for `startup_preflight_failed` or `shutdown_timeout`

## Cash reconciliation exception

1. Run `npm run integrity:scan`
2. Review admin reconciliation endpoints
3. Do not mutate journal entries manually without approved correction workflow

## Migration failure

1. Inspect `schema_migrations` for `failed` status
2. Fix root cause on disposable environment first
3. Retry `npm run migrate` after clearing stale lock if needed

## Credential incident

1. Rotate `JWT_SECRET` (forces re-login)
2. Increment affected user `tokenVersion`
3. Review audit logs for suspicious admin/staff activity
