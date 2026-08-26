# AJ Gold Backend — Final Production Audit

**Audit role:** Phase 7 operational closure and release-content correction.
**Product:** cash/money contribution scheme (not gold-weight accounting).

The exact release commit, ZIP byte count and SHA-256 are recorded only by the generated external release manifest. This document does not embed a self-referential release commit or ZIP hash.

---

## 1. Accepted product contract

- Cash-only contribution scheme.
- No gold rate, weight, purity, inventory or delivery accounting.
- Customers cannot pay through the application. Staff/admin record externally collected payments.
- No MFA or account-deletion workflow.
- Four-character passbook credentials are intentional for customer login.
- Direct settlement payout methods: CASH, UPI and BANK.
- Maturity redemption and early-closure payout are principal-only (eligible contribution total; no bonus, penalty or deduction).
- Payment correction is the only maker/checker workflow.
- Scheme duration is 11 months. Months 1–6 allow any number of positive whole-rupee contributions. Months 7–11 are capped at the months 1–6 combined effective total.
- No public self-registration. Customers are created by staff/admin.

---

## 2. Verdicts

| Verdict | Result |
| --- | --- |
| **CODE-READY** | **YES** |
| **PRODUCTION-READY** | **YES** |
| **DEPLOY** | **YES** — approved to deploy |
| **Deployment occurred** | **NO** |

Runtime source baseline for the accepted Phase 7 closure is the production tree that completed operational gates. This packaging correction does not change financial behavior. Exact artifact identity is in the external manifest.

---

## 3. Migrations

Production migrations in package: **001–011** (eleven files).

Deploy with a dedicated migration credential, then switch to the restricted runtime credential. Do not run migrations against an arbitrary persistent database from a developer workstation as a substitute for production deploy.

---

## 4. Phase 7 operational closure (reused evidence)

Runtime source was unchanged for these gates. They remain accepted and were not rerun for this packaging-only correction.

| Gate | Result |
| --- | --- |
| `npm test` | **232 pass**, 0 fail / cancelled / skipped |
| Regression matrix | **160 pass**, 0 fail / cancelled / skipped |
| Complete smoke matrix | **PASS** without retries |
| Production dependency audit (`npm audit --omit=dev`) | **0 vulnerabilities** |
| Backup / restore drill | **PASS** |
| Restricted MongoDB RBAC drill | **PASS** |
| 10,000-customer benchmark | **PASS** |

---

## 5. Findings

- **P0:** none
- **P1:** none
- **P2 (accepted, non-blocking):**
  - Dev-only `brace-expansion` advisory via nodemon/minimatch. Not present in a production (`--omit=dev`) install. Not invoked by start, migrate, test or release scripts.
  - `Scheme.find({ customer })` in customer detail remains a later indexing opportunity. Required migrations do not add a broad non-partial customer/scheme lookup index. Command count matched the accepted Phase 6/7 read path; not treated as a Phase 7 regression.

---

## 6. Frozen implementation markers (confirmed)

- Settlement rejects caller `settlementAmount`; entitlement is server-computed.
- Allowed settlement payout methods are CASH, UPI and BANK only.
- `makingChargeAffectsPayout` is false.
- Production `src/` has no gold-rate, gold-weight, inventory or delivery-schedule product logic.
- No customer self-registration route.

---

## 7. Deployment / rollback handoff

Deployment has **not** occurred.

### Prerequisites

- MongoDB replica set with transaction support
- Production env: `JWT_SECRET` (≥32 characters), `CORS_ORIGINS` (non-empty exact allowlist), `MONGO_URI` with an explicit database name
- Do not require removed MFA secrets

### Deploy order

1. `npm ci --ignore-scripts`
2. `npm run migrate` then `npm run migrate:verify` (migrations **001–011**)
3. `npm run verify:indexes`
4. `npm run integrity:scan` (read-only; expect `ok: true` on a clean migrated database)
5. `npm start` — confirm `GET /api/health/ready` → 200
6. Start outbox worker: `node src/workers/outboxWorker.js`

### Rollback limits

- Application rollback: redeploy the prior artifact
- Database rollback only if migrations are backward-compatible; review `docs/MIGRATIONS.md` before destructive rollback
- Take a mongodump before the first production migrate

### Never in production

- `npm run reset:demo`
- `npm run seed:cash-vault-demo`
- Model-driven `syncIndexes()` auto-indexing

---

## 8. Release packaging

Use `npm run package:release` with `RELEASE_OUTPUT_DIR` set to a directory **outside** the repository.

The packager:

- Requires a clean Git working tree
- Builds from the current HEAD via `git archive` (committed files only)
- Writes `RELEASE_CONTENTS.manifest.json` inside the ZIP (per-file path, bytes, SHA-256; no self-hash of that file)
- Writes an external manifest beside the ZIP with filename, bytes, SHA-256, full commit, creation UTC, Node/npm, package-lock SHA-256, migration range 001–011, and `deploymentOccurred: false`

Do not treat any earlier ZIP hash as current. Former packaging identities are superseded by the artifact named in the new external manifest.

---

*End of final production audit. Code-ready and production-ready. Approved to deploy. Deployment has not occurred.*
