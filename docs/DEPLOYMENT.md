# Deployment

## Preconditions

- MongoDB replica set with transaction support
- Migrations applied: `npm run migrate`
- Indexes verified: `npm run verify:indexes`
- Production env vars set (see `.env.example`)

## Release steps

1. Set `NODE_ENV=production`
2. Configure `MONGO_URI`, `JWT_SECRET`, `CORS_ORIGINS`
3. Run `npm ci --ignore-scripts`
4. Run `npm run migrate` against target database
5. Run `npm run migrate:verify`
6. Run `npm run verify:indexes`
7. Start `npm start`
8. Confirm `GET /api/health/ready` returns 200

## Rollback

1. Stop traffic to new instance
2. Restore previous application artifact
3. If migrations are backward compatible, no DB rollback required
4. If migration introduced irreversible schema change, follow migration runbook before rollback

## Never in production

- `npm run reset:demo`
- `npm run seed:cash-vault-demo`
- `syncIndexes()` or model-driven auto-indexing (disabled when `NODE_ENV=production`)
