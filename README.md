# AJ Gold Kambil Backend

Node.js API for staff/admin-managed customer schemes, collections, custody, settlement, and audit.

## Requirements

- Node.js 20+
- MongoDB replica set (required for financial transactions)
- npm 10+

## Quick start (development)

```bash
cp .env.example .env
npm ci
npm run migrate
npm run dev
```

Health endpoints:

- Liveness: `GET /api/health/live`
- Readiness: `GET /api/health/ready`
- Metrics snapshot: `GET /api/health/metrics`

## Production rules

Production boot fails closed when:

- `JWT_SECRET` is weak or missing
- `CORS_ORIGINS` is empty or wildcard
- `MONGO_URI` lacks an explicit non-demo database name
- MongoDB is not a replica set or transactions are unavailable
- Required migrations/indexes are missing (readiness check)

Never run destructive scripts against production.

## Scripts

| Command | Purpose |
|---|---|
| `npm test` | Full test suite on in-memory replica set |
| `npm run migrate` | Apply versioned migrations |
| `npm run migrate:verify` | Verify applied migrations/checksums |
| `npm run verify:indexes` | Verify required index manifest |
| `npm run integrity:scan` | Read-only financial integrity scan |
| `npm run backup:db` | Backup disposable demo/test DB (`mongodump`) |
| `npm run restore:db` | Restore archive to disposable DB |
| `npm run reset:demo` | Drop and reseed demo DB (guarded) |

## Destructive demo reset guard

All destructive scripts require:

1. `NODE_ENV` not `production`
2. `ALLOW_DATABASE_RESET=true`
3. Database name containing `dev`, `demo`, or `test`
4. `CONFIRM_DATABASE_RESET=<exact-database-name>`

## API versioning

Current routes remain under `/api/*` for compatibility. Future external versioning may introduce `/api/v1/*` without breaking existing clients.

## Documentation

- [Deployment](docs/DEPLOYMENT.md)
- [Migrations](docs/MIGRATIONS.md)
- [Backup & Restore](docs/BACKUP_RESTORE.md)
- [Incident Response](docs/INCIDENT_RESPONSE.md)
- [Reconciliation Runbook](docs/RECONCILIATION.md)
