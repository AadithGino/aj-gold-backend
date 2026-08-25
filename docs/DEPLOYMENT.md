# Deployment

## Preconditions

- MongoDB replica set with transaction support
- Migrations applied: `npm run migrate`
- Indexes verified: `npm run verify:indexes`
- Production env vars set (see `.env.example`)

## Financial journal DB permissions

- Application runtime credential:
  - may `find` and `insert` on `financialjournals`
  - must not have `update`, `findAndModify`, `remove`, `delete`, or `replace` capabilities on `financialjournals`
- Migration/index administration must run with a separate restricted deployment credential used only for deployment operations.
- Do not reuse the migration/index credential as the normal application runtime credential.

### Operator role verification before deployment

1. Authenticate to MongoDB with the intended runtime app user (non-admin deployment shell).
2. Run a role-introspection check and confirm that `financialjournals` grants only read/insert-style actions to the runtime user.
3. Validate by policy that update/replace/delete-style actions are not present for `financialjournals`.
4. Re-authenticate with the migration/index deployment credential and confirm that elevated DDL/administrative actions are isolated to deployment execution.
5. Record the verification result in the release checklist before running `npm run migrate` and `npm run verify:indexes`.

Example verification commands (replace placeholders with your own non-secret values):

- `db.runCommand({ usersInfo: "<app-user>", showPrivileges: true })`
- `db.runCommand({ connectionStatus: 1, showPrivileges: true })`

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
