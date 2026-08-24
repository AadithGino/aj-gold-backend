# Migrations

Migrations live in `src/migrations/versions/` with ordered IDs and SHA-256 checksums.

## Commands

```bash
npm run migrate
npm run migrate:dry-run
npm run migrate:verify
```

## Guarantees

- Ordered execution with checksum drift detection
- Lease lock prevents concurrent runners
- Applied records store `running`, `applied`, or `failed` status with timestamps
- Failed migrations may be retried after stale `running` lock expires

## Rules

- Never use `syncIndexes()` as a migration substitute in production
- Never auto-delete conflicting legacy financial data
- Resolve duplicate ACTIVE scheme data manually before applying `001`
