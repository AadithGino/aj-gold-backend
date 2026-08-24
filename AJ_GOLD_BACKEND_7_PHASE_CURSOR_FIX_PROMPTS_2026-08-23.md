# AJ Gold Backend — Seven Phase-Locked Cursor Fix Prompts

Prepared for: `backend zip(4).zip`  
Baseline SHA-256: `c9ac2a4e645d665b8c6c918f56ad2c116f90b2d33cfbbad27e5f2b71029afef2`  
Source audit: `AJ_GOLD_BACKEND_ZIP4_FILE_BY_FILE_AUDIT_2026-08-23.md`

## How to use this prompt pack

1. Extract ZIP 4 into one clean Cursor workspace.
2. Commit or copy the untouched baseline before Phase 1.
3. Run **one phase at a time, in order**.
4. Do not paste the next phase until the current phase returns its completion report and all mandatory gates pass.
5. After each phase, keep the modified workspace as the input to the next phase. Do not re-extract ZIP 4 and do not copy individual files from older archives.
6. If Cursor reports a blocker, resolve that blocker in the same phase. Do not silently defer a phase acceptance criterion.
7. Phase 3 contains an owner-decision gate for the cash settlement formula. Fill in the decision block before running Phase 3. Cursor must not invent that financial rule.
8. Phase 7 is the final audit and code-freeze gate. Do not add features after it passes.

## Frozen business contract for every phase

These rules override assumptions in the existing code:

- This is a **cash-based 11-month scheme**.
- Do not introduce gold rate, gold weight, purity, gold inventory, gold delivery, jewellery delivery, or gold-liability accounting.
- There is no customer payment gateway and no in-app customer payment creation.
- Only authorized staff/admin users record money collected from customers.
- Store the collection payment method. Existing methods may remain, but any non-cash method must have verifiable reference data.
- During scheme months 1–6, a customer may pay any positive whole-rupee amount, any number of times.
- The rule is based on the **combined total**, never an average.
- During months 7–11, the combined later-period total must never exceed the combined months 1–6 total.
- Define the time windows as half-open intervals using one canonical Asia/Kolkata policy:
  - first period: `startDate <= effectivePaymentAt < startDate + 6 calendar months`;
  - later period: `startDate + 6 calendar months <= effectivePaymentAt < startDate + 11 calendar months`;
  - at or after `startDate + 11 calendar months`: payment is prohibited.
- Customers must not be able to call a payment-create endpoint.
- Customer enrollment remains staff/admin-created. Do not reintroduce public self-registration unless the owner separately changes this contract.
- The predictable four-character passbook-number customer password is intentional. Preserve it. Do not report or “fix” it as a security defect.
- Customer passbook credentials and privileged staff/admin credentials are separate policies. Hardening staff/admin authentication must not alter the accepted customer passbook behavior.
- Admin must have complete operational visibility.
- Ordinary payments may never exceed the cap, including admin-entered payments. A free-text override must not make an invalid ordinary payment valid.
- All money remains integer whole rupees unless a migration and API-wide monetary-unit change is explicitly approved. Do not introduce floating-point money.

## Global engineering rules for every Cursor phase

- Read every named file and its imports/callers before editing.
- Search the whole repository for every affected field, status, permission, route, and model. Do not patch one call site while leaving another bypass.
- Preserve unrelated behavior and public response shapes unless the phase explicitly authorizes a contract change.
- Use MongoDB transactions for multi-record financial mutations and propagate the same session to every read/write that participates in the invariant.
- Never perform external calls inside an open database transaction. Use an outbox or post-commit worker.
- Use compare-and-set/version locks and database unique constraints for concurrent financial workflows; service pre-checks alone are insufficient.
- Never mutate historical monetary truth in place. New financial corrections/reversals must be append-only and linked to the source event.
- Migrations must be versioned, checksum-protected, idempotent, restart-safe, and data-safe. Never use production `syncIndexes()` as a migration strategy.
- Do not use Redis. If durable rate limiting or locking is needed, use MongoDB-backed state or another already-approved persistent component.
- Do not run destructive seed/reset operations against any non-demo database.
- Never embed or print known credentials.
- Add tests before declaring a finding fixed.
- Do not call cancelled, skipped, or environment-blocked tests “passed.”
- Do not modify `.env` with real secrets or package secrets in the output archive.
- Do not begin later-phase work early.
- At the end of each phase, provide exact files changed, migrations added, API changes, commands run, test counts, failures/skips, and remaining findings.

---

# PHASE 1 PROMPT — Canonical Scheme Window and Payment Invariant

Copy everything inside this section into Cursor.

```text
You are implementing AJ Gold Backend Corrective Phase 1 only.

BASELINE
- Begin from backend zip(4).zip or the clean committed ZIP 4 workspace.
- Baseline archive SHA-256: c9ac2a4e645d665b8c6c918f56ad2c116f90b2d33cfbbad27e5f2b71029afef2.
- Do not copy financial code from older archives.

PHASE 1 GOAL
Make the 11-month payment window and first-six/later-period cap one canonical, unavoidable financial invariant. Fix caller-controlled dates, contradictory cutoff semantics, post-maturity payments, and ordinary admin cap override. Do not work on corrections, ledger settlement, auth, deletion, observability, or deployment beyond tests needed for this phase.

FROZEN BUSINESS RULES
- Cash-based scheme only; no gold fields or calculations.
- Customers cannot create payments.
- First period: startDate inclusive to startDate + 6 calendar months exclusive.
- Later period: startDate + 6 calendar months inclusive to startDate + 11 calendar months exclusive.
- At/after startDate + 11 calendar months, no payment is allowed.
- Months 1-6: any positive whole-rupee amount and any number of payments.
- Months 7-11 combined successful total must be <= combined successful first-period total.
- No average calculation.
- No admin override for an ordinary over-cap payment.
- Use Asia/Kolkata as the business timezone whenever a date-only input must be converted to an instant.
- Preserve the intentional four-character passbook customer password and all unrelated authentication behavior.

READ AND TRACE BEFORE EDITING
- src/services/payment.service.js
- src/services/paymentLimit.service.js
- src/services/scheme.service.js
- src/services/schemeManagement.service.js
- src/utils/date.js
- src/utils/scheme.js
- src/utils/money.js
- src/validation/financial.validation.js
- src/models/payment.model.js
- src/models/scheme.model.js
- src/controllers/payment.controller.js
- src/routes/payment.routes.js
- src/routes/scheme.routes.js
- test/financial.test.js
- every reference to paymentDate, sixMonthDate, maturityDate, limitOverride, overrideReason, ACTIVE, SUCCESS, financialVersion, and willNewPaymentExceedLimit

REQUIRED IMPLEMENTATION
1. Create one canonical scheme-window policy module or refactor paymentLimit.service.js into the single policy authority. It must return explicit instants and period classification using the exact half-open intervals above.
2. Stop using mixed calendar-day and exact-timestamp comparisons. The same classifier/predicates must be used for validation, aggregation, summaries, dashboards consumed by payment flow, and tests.
3. Keep recorded-at time and effective-payment time distinct.
   - recordedAt/createdAt is server time and immutable.
   - The normal collection endpoint must use a server-controlled effective time.
   - Do not accept arbitrary staff backdating or future dating in normal payment collection.
   - If the existing request contains paymentDate, either reject non-current values with a stable error or ignore it in favor of server time only if that does not create a misleading API. Prefer explicit rejection.
   - A reviewed historical-adjustment workflow is later-phase scope; do not create a hidden backdate bypass here.
4. Validate that effectivePaymentAt is >= scheme start and < maturity before any financial write.
5. Reject payments for inactive, settled, closed, redeemed, or matured schemes with stable error codes.
6. Remove the admin ordinary-payment limit override path completely from collection validation and persistence. Remove or deprecate limitOverride/overrideReason fields only through a safe migration if stored legacy data requires retention. Never erase existing audit evidence.
7. Compute first-period and later-period totals from successful, non-reversed ledger-relevant payments using identical boundary predicates.
8. Under the existing scheme financial lock and MongoDB transaction, enforce:
   proposedLaterTotal <= firstPeriodTotal.
9. Define behavior when firstPeriodTotal is zero: every positive later-period payment must be rejected.
10. Keep positive whole-rupee parsing and unlimited payment count during months 1-6.
11. Preserve CUSTOMER denial on payment-create routes.
12. Add stable error codes for PAYMENT_BEFORE_SCHEME_START, PAYMENT_AFTER_MATURITY, PAYMENT_DATE_NOT_ALLOWED, and PAYMENT_LIMIT_EXCEEDED if equivalent stable codes do not already exist. Do not mislabel them as generic validation errors.
13. Update API comments/tests/serializers that expose inFirstSixMonths or remainingAllowedPayment so their classification matches the canonical policy.

MANDATORY TESTS
- payment exactly at startDate: accepted.
- payment one millisecond before startDate: rejected.
- payment one millisecond before laterPeriodStart: first period.
- payment exactly at laterPeriodStart: later period.
- payment later on the same calendar day as laterPeriodStart: later period.
- payment one millisecond before maturity: allowed if within cap.
- payment exactly at maturity: rejected.
- payment after maturity: rejected.
- future-dated caller input: rejected.
- backdated caller input: rejected on normal endpoint.
- first-period total zero plus later payment: rejected.
- later payment one rupee below cap, exactly at cap, and one rupee above cap.
- multiple first-period payments prove total-based, not average-based behavior.
- admin over-cap attempt is rejected even with legacy overrideReason.
- customer role cannot create payment.
- two concurrent later-period payments cannot jointly exceed the cap.
- Asia/Kolkata boundary test around midnight/UTC offset.

MANDATORY GATES
- npm ci --ignore-scripts
- syntax-check every JavaScript source/test file with node --check
- run the focused Phase 1 tests against a real MongoDB replica set
- run the complete existing test suite against a real MongoDB replica set
- npm audit --omit=dev --audit-level=high
- no cancelled/skipped database test may be reported as pass

DO NOT CHANGE
- No gold rate, weight, purity, delivery, or jewellery features.
- No payment gateway.
- No customer payment endpoint.
- No public self-registration.
- Do not change the four-character passbook password behavior.
- Do not implement cash entitlement/settlement redesign yet.
- Do not implement correction ledger changes yet, except compile fixes caused directly by the canonical window API.
- Do not add broad auth, deletion, reporting, or observability changes.

PHASE COMPLETION RESPONSE
Return:
1. PHASE 1 CODE-READY: YES/NO.
2. Every changed/added/removed file and why.
3. Exact canonical boundary semantics and examples.
4. API/error-code changes.
5. Tests added, commands run, exact pass/fail/cancel/skip counts.
6. Confirmation that customer payment remains impossible, passbook password is unchanged, no gold logic was added, and cap override was removed.
7. Remaining blockers for later phases.

Stop after Phase 1. Do not begin Phase 2.
```

### Phase 1 acceptance gate

- All boundary and cap tests pass on a real replica set.
- No ordinary payment path accepts caller-selected historical/future dates.
- No role can create an ordinary over-cap payment.
- Post-maturity collection is impossible.
- No customer payment route or gold logic was added.

---

# PHASE 2 PROMPT — Corrections, Reversals, Concurrency and Idempotency

```text
You are implementing AJ Gold Backend Corrective Phase 2 only.

PRECONDITION
- Start from the Phase 1 completed workspace, not the original ZIP.
- Phase 1 full tests and real-replica-set boundary tests must be green.
- If Phase 1 is incomplete, stop and report the missing gate.

PHASE 2 GOAL
Make corrections, reversals, enrollment creation, and retry behavior preserve the canonical Phase 1 financial invariant under concurrency. Do not begin settlement-ledger redesign, auth hardening, reporting redesign, deletion, or deployment work.

FROZEN RULES
- Retain all Phase 1 scheme-window semantics.
- A correction or reversal may never leave laterPeriodPaid > firstPeriodPaid.
- Ordinary financial history must not be overwritten without an append-only adjustment trail.
- Exactly one ACTIVE scheme may exist per customer.
- Same idempotency key + same client intent returns the original result.
- Same idempotency key + different client intent returns IDEMPOTENCY_KEY_REUSED.
- Server-generated timestamps must not change the client-intent hash on retry.
- Customer payment denial, cash-only scope, and passbook-password design remain unchanged.

READ AND TRACE BEFORE EDITING
- all Phase 1 changed files
- src/services/correction.service.js
- src/services/payment.service.js
- src/services/paymentLimit.service.js
- src/services/idempotency.service.js
- src/services/cash.service.js
- src/services/scheme.service.js
- src/services/schemeManagement.service.js
- src/models/paymentCorrection.model.js
- src/models/idempotencyRecord.model.js
- src/models/payment.model.js
- src/models/scheme.model.js
- src/utils/requestHash.js
- src/utils/transaction.js
- src/validation/financial.validation.js
- src/controllers/correction.controller.js
- src/routes/correction.routes.js
- test/financial.test.js
- all callers of EDIT_AMOUNT, EDIT_DATE, reversal, clientRequestId, financialVersion, create scheme/enrollment, and startTransaction

REQUIRED IMPLEMENTATION
1. Make correction approval acquire the same scheme financial compare-and-set/version lock used by collection, inside one MongoDB transaction.
2. Before approval, calculate the proposed ledger state by excluding the source payment value and including the proposed adjustment. Use the canonical Phase 1 classifier.
3. Reject amount/date corrections that create any of these states:
   - payment before scheme start;
   - payment at/after maturity;
   - later total above first-period total;
   - invalid/non-positive/unsafe money;
   - correction after settlement/final closure.
4. Replace in-place amount/method/date edits with append-only correction/adjustment events linked to the original payment. Preserve the original payment facts. If existing API responses expect an effective view, derive that view from source + approved adjustments without erasing history.
5. Make reversals append-only and revalidate the resulting cap. Specifically, reversing/reducing a first-period payment must fail or trigger a separately reviewed compensating workflow when existing later payments would exceed the reduced cap.
6. Ensure only one concurrent correction decision wins. Approve/reject and approve/approve races must have one final result and stable conflict errors.
7. Add a data-safe, versioned migration for exactly one ACTIVE scheme per customer using a partial unique index.
   - Scan and report duplicate legacy active schemes before creating the index.
   - Never auto-delete or auto-merge financial schemes.
   - If duplicates exist, migration must stop with actionable IDs.
8. Make both scheme-creation entry points transactional/idempotent and handle duplicate-key races as a domain conflict, not an idempotency error.
9. Fix payment and cash-submission idempotency hashing:
   - hash normalized client intent before server timestamps/defaults are added;
   - reserve the operation key safely;
   - exact retry returns original stored response;
   - altered payload returns IDEMPOTENCY_KEY_REUSED;
   - in-flight duplicate returns a stable retryable conflict.
10. Ensure duplicate-key middleware maps by constraint/index context. Do not map phone, active scheme, employee code, passbook, receipt, or enrollment duplicates to IDEMPOTENCY_KEY_REUSED.
11. Keep every transaction session on all participating reads/writes and preserve transaction retry semantics.

MANDATORY TESTS
- EDIT_AMOUNT increasing a later payment above cap: rejected.
- EDIT_AMOUNT reducing/increasing first-period payment with existing later payments: valid case accepted, invalid cap case rejected.
- EDIT_DATE moving first -> later and later -> first with full invariant revalidation.
- correction before start and at/after maturity: rejected.
- correction after settlement: rejected.
- correction concurrent with new collection: invariant preserved.
- correction concurrent with settlement-status transition: one valid winner.
- approve/approve and approve/reject races: exactly one final decision.
- reversal of first-period payment that would invalidate later total: rejected or routed to explicit reviewed compensation; no invalid state.
- reversal of later-period payment: correct totals and append-only history.
- original payment facts remain queryable after adjustment/reversal.
- same payment key with omitted effective date retries successfully.
- same cash-submission key with omitted submission date retries successfully.
- same key/different payload returns correct stable code.
- two concurrent active-scheme creates result in exactly one active scheme.
- migration on clean DB, legacy valid DB, and duplicate-active fixture.
- migration rerun is idempotent and checksum-stable.

MANDATORY GATES
- syntax check
- focused Phase 1 + Phase 2 suite on a real replica set
- full npm test on a real replica set
- migration dry-run and apply on disposable legacy fixtures
- required-index verification from empty and upgraded databases
- npm audit production dependencies

DO NOT CHANGE
- Do not invent cash settlement entitlement.
- Do not implement cash payout workflow yet.
- Do not change customer credential design or public enrollment policy.
- Do not add gold/payment-gateway logic.
- Do not redesign reports, notifications, deletion, or observability.
- Do not use production syncIndexes as a migration.

PHASE COMPLETION RESPONSE
Return:
1. PHASE 2 CODE-READY: YES/NO.
2. Files and migrations changed.
3. Adjustment/reversal data model and effective-view behavior.
4. Active-scheme index definition and duplicate-data behavior.
5. Idempotency canonicalization details.
6. Exact gate commands and counts.
7. Proof that Phase 1 invariants remain green.
8. Remaining later-phase blockers.

Stop after Phase 2. Do not begin Phase 3.
```

### Phase 2 acceptance gate

- Corrections and reversals cannot create an invalid cap state.
- Original financial facts are preserved.
- Exactly one active scheme is database-enforced.
- Timestamp-omitted idempotent retries work correctly.
- Phase 1 stays green.

---

# PHASE 3 PROMPT — Cash Entitlement, Settlement and Immutable Financial Journal

## Owner decision required before pasting Phase 3

Fill this block with the approved business answer. Do not let Cursor choose it:

```text
MATURITY CASH ENTITLEMENT FORMULA: [OWNER MUST FILL]
EARLY CLOSURE ALLOWED: [YES/NO]
EARLY CLOSURE CASH FORMULA: [OWNER MUST FILL OR NOT APPLICABLE]
BONUS/BENEFIT RULE: [OWNER MUST FILL]
DEDUCTIONS/PENALTIES: [OWNER MUST FILL]
ROUNDING RULE: [OWNER MUST FILL]
ALLOWED PAYOUT METHODS: [OWNER MUST FILL]
MAKER/CHECKER ROLES: [OWNER MUST FILL]
CUSTOMER ACKNOWLEDGEMENT METHOD: [OWNER MUST FILL]
```

If the scheme returns only principal, explicitly write: `successful non-reversed contribution total; no bonus; no deduction`.

```text
You are implementing AJ Gold Backend Corrective Phase 3 only.

PRECONDITION
- Start from the completed Phase 2 workspace.
- Phases 1-2 and migration gates must be green.
- The OWNER DECISION block supplied with this prompt must be complete.
- If any entitlement/payout field is missing or contradictory, STOP with DECISION REQUIRED. Do not infer a gold benefit, market value, bonus, discount, or penalty.

PHASE 3 GOAL
Replace caller-invented settlement amounts and mutable monetary truth with a server-computed cash entitlement and append-only financial journal. Implement controlled settlement request, approval, payout, acknowledgement, and finalization. Do not work on broad reporting performance, authentication, deletion, or deployment beyond phase dependencies.

FROZEN RULES
- Cash only. No gold fields, rates, weights, purity, delivery, or jewellery settlement.
- Entitlement uses the owner-approved formula exactly.
- A caller never supplies the authoritative settlement amount.
- Default final settlement authority is admin only unless the completed maker/checker rule says otherwise.
- Requester and approver must be different when maker/checker is required.
- Status alone must never be treated as proof that money was paid.
- Historical journal entries are immutable; fixes are reversals/compensating entries.
- Preserve Phase 1-2 cap, correction, idempotency, and concurrency invariants.

READ AND TRACE BEFORE EDITING
- all Phase 1-2 changed files and migrations
- src/services/schemeManagement.service.js
- src/services/cashPosition.service.js
- src/services/cash.service.js
- src/services/staffCash.service.js
- src/services/payment.service.js
- src/services/correction.service.js
- src/services/report.service.js
- src/services/dashboard.service.js
- src/models/scheme.model.js
- src/models/payment.model.js
- src/models/cashSubmission.model.js
- src/models/auditLog.model.js
- src/models/idempotencyRecord.model.js
- src/validation/financial.validation.js
- src/controllers/scheme.controller.js
- src/routes/scheme.routes.js
- src/constants/enums.js
- src/constants/errorCodes.js
- every reference to settlementAmount, totalPaidAtSettlement, REDEEMED, CLOSED, cashInVault, totalCustomerSettlement, and canMarkRedeemed

REQUIRED IMPLEMENTATION
1. Introduce an append-only financial journal model/service with at least:
   - immutable entry ID and unique business key;
   - event type;
   - amount in whole rupees;
   - debit/credit account or explicit source/destination custody accounts;
   - customer, scheme, source record, actor, request ID;
   - effectiveAt and recordedAt;
   - reversalOf/compensates link;
   - transaction/session support;
   - timestamps and appropriate indexes.
2. Required journal event coverage:
   - collection received;
   - collection adjustment;
   - collection reversal;
   - staff cash custody received;
   - staff cash submitted to vault;
   - vault adjustment/reversal;
   - settlement entitlement recognized;
   - settlement authorized;
   - settlement paid;
   - settlement reversal/adjustment when legally allowed.
3. Add a data-safe, idempotent migration/backfill strategy for legacy valid financial records. It must detect ambiguity/duplicates and stop rather than fabricate entries.
4. Create one server-side entitlement service implementing only the completed owner decision. Return a deterministic breakdown: eligible contributions, benefit/bonus, deductions, rounding, final entitlement, formula version.
5. Remove settlementAmount as caller authority. A preview endpoint may return the computed amount; request/approval must store the formula version and immutable input snapshot.
6. Implement explicit settlement states, for example DRAFT/REQUESTED, APPROVED, PAYOUT_PENDING, PAID, ACKNOWLEDGED, FINALIZED, REJECTED/CANCELLED where allowed. Use names consistent with the codebase but preserve the separation of authority and actual payout.
7. Require payout method, unique external/manual disbursement reference, paidAt, payer actor, evidence metadata, and recipient acknowledgement before finalization.
8. Do not store sensitive raw documents directly in MongoDB. Store controlled object references/checksums if evidence files are supported.
9. Ensure only one settlement attempt/finalization wins under concurrency using unique keys and compare-and-set.
10. Settlement must lock the scheme and reject any new payment/correction race after authorization/finalization according to the approved workflow.
11. A status transition must not subtract vault cash until a journaled PAYOUT event occurs.
12. Keep audit log for operational forensics, but do not use mutable AuditLog as the accounting ledger.
13. Add admin detail endpoints for entitlement breakdown, settlement history, evidence/reference, actors, journal references, and exceptions. Preserve existing response fields where possible; add versioned fields rather than silently changing meaning.

MANDATORY TESTS
- deterministic entitlement for every owner-approved maturity/early rule.
- caller-supplied different amount is rejected/ignored and cannot alter entitlement.
- underpayment and overpayment cannot finalize silently.
- settlement before eligibility is rejected.
- two concurrent settlement requests/approvals/finalizations: one valid winner.
- requester cannot approve own request when maker/checker required.
- PAID requires payout reference/method/evidence metadata.
- FINALIZED requires acknowledgement if owner contract requires it.
- status change without PAYOUT journal does not reduce vault cash.
- payout journal is idempotent.
- payment/correction concurrent with settlement preserves one valid state.
- original entries are immutable; reversal uses linked compensating entry.
- legacy backfill on empty, valid, duplicate, ambiguous, and already-migrated fixtures.
- all Phase 1-2 tests remain green.

MANDATORY GATES
- syntax check
- focused journal/entitlement/settlement unit tests
- real-replica-set integration and concurrency tests
- migration/backfill dry-run and apply on disposable legacy fixtures
- full npm test
- npm audit production dependencies

DO NOT CHANGE
- Do not introduce any gold concept.
- Do not guess missing economics.
- Do not permit manual settlement amount override.
- Do not let staff settle by default.
- Do not rewrite original payments in place.
- Do not begin broad report optimization, auth, deletion, CORS, observability, or deployment work.

PHASE COMPLETION RESPONSE
Return:
1. PHASE 3 CODE-READY: YES/NO.
2. Echo the exact owner-approved entitlement contract implemented.
3. Journal schema/accounts/events and immutability mechanism.
4. Settlement state machine and role matrix.
5. Migration/backfill behavior and unresolved legacy records.
6. API additions/compatibility notes.
7. Exact commands and test counts.
8. Proof that Phases 1-2 remain green.

Stop after Phase 3. Do not begin Phase 4.
```

### Phase 3 acceptance gate

- The owner decision block is complete.
- Settlement amount is computed, never caller-authoritative.
- Payout and finalization are distinct evidenced events.
- Journal is immutable and reconciles the tested ledger.
- Phases 1–2 stay green.

---

# PHASE 4 PROMPT — Cash Custody, Reconciliation, Reports and Notifications

```text
You are implementing AJ Gold Backend Corrective Phase 4 only.

PRECONDITION
- Start from completed Phase 3.
- The journal backfill, entitlement, and settlement tests must be green.
- If journal balances do not reconcile before this phase, stop and fix Phase 3 first.

PHASE 4 GOAL
Make staff cash, vault cash, payment-method evidence, admin reporting, business timezone, pagination, and notification delivery production-safe using the Phase 3 journal as monetary truth.

FROZEN RULES
- Cash-based scheme; no gold features.
- Staff physically collect and record payments; customer still cannot pay from app.
- CASH creates staff/admin cash custody entries.
- UPI/BANK/CARD, if retained, require appropriate transaction reference and verification metadata.
- Admin must be able to inspect every collection, correction, custody transfer, settlement, exception, and actor.
- Asia/Kolkata is the business timezone.
- Financial totals come from immutable journal entries, not mutable status shortcuts.
- Preserve Phases 1-3 and passbook credential behavior.

READ AND TRACE BEFORE EDITING
- Phase 3 journal/settlement files
- src/services/cash.service.js
- src/services/staffCash.service.js
- src/services/cashPosition.service.js
- src/services/report.service.js
- src/services/dashboard.service.js
- src/services/customer.service.js
- src/services/payment.service.js
- src/services/notification.service.js
- src/services/receipt.service.js
- src/controllers/admin.cashSubmission.controller.js
- src/controllers/report.controller.js
- src/controllers/dashboard.controller.js
- src/controllers/notification.controller.js
- relevant cash/report/dashboard/notification routes
- cash/payment/notification/audit/journal models
- src/utils/date.js
- src/constants/staffPermissions.js
- all regex searches, fixed limits, Promise.all enrichment, unawaited notification calls, and aggregation date operators

REQUIRED IMPLEMENTATION
1. Derive and clearly separate:
   - total customer money collected;
   - cash physically with each staff member;
   - cash submitted to vault;
   - verified non-cash receipts;
   - vault adjustments;
   - settlement authorized but not paid;
   - settlement paid;
   - actual cash/liquid position;
   - reconciliation exceptions.
2. Replace status-based/subtractive cash formulas with journal-backed balances and invariant checks.
3. Implement cash-submission correction/reversal/adjustment workflow so legitimate payment corrections never require direct DB edits. Require admin review, reason, evidence, idempotency, and append-only journal events.
4. Prevent staff cash from going negative under concurrent collection reversal, submission, and adjustment.
5. Require transactionReference for every non-CASH payment method. Add method-specific normalized fields/checks where appropriate without storing unnecessary sensitive data.
6. Make receipt and business-day numbering use explicit Asia/Kolkata boundaries.
7. Convert all daily/weekly/monthly/hourly report boundaries to one timezone utility. MongoDB aggregation operators must specify timezone where supported. Document week start.
8. Replace N+1 scheme/customer/report enrichment with bounded aggregation/batching. Avoid 3 queries per row and 1,500-query 500-row reports.
9. Add stable cursor/keyset pagination and bounded page sizes to payment, customer, staff, correction, audit, settlement, cash, notification, and report lists. Preserve compatibility only through bounded transitional fields; never support unbounded legacy-all.
10. Escape literal search input or use safe indexed search. Reject pathological regex patterns.
11. Add admin oversight endpoints for:
    - audit log search/detail;
    - journal entries and source links;
    - idempotency investigation;
    - cash/custody reconciliation exceptions;
    - settlement evidence/status;
    - integrity summary.
12. Implement a transactional outbox for payment, correction, cash submission, and settlement notifications.
    - Financial transaction writes outbox record.
    - Worker sends after commit.
    - Retry with bounded exponential backoff.
    - Deduplication key and delivery state.
    - Failure does not roll back committed money but is visible/retryable.
13. Do not invent an external push provider. Keep provider adapter boundaries clear; persistence/retry must work even if only an in-app adapter is configured.

MANDATORY TESTS
- cash collection increases correct staff custody and ledger balance.
- submission moves custody staff -> vault exactly once.
- concurrent submissions cannot overdraw staff cash.
- cash payment reversal after submission routes through reviewed adjustment and reconciles.
- staff deactivation does not hide outstanding cash.
- status-only settlement change cannot alter cash position.
- non-cash collection without reference is rejected; CASH does not require a bank reference.
- reconciliation equation holds after collect, submit, correct, reverse, settle, and payout sequences.
- Asia/Kolkata midnight, month-end, year-end, DST-neutral, and UTC-server tests.
- cursor pagination has no duplicates/gaps under stable ordering and enforces max page size.
- report query-count/performance assertion prevents N+1 regression.
- regex-special user input is treated literally/safely.
- outbox event created atomically with financial mutation.
- worker retry/dedupe/crash-recovery tests.
- admin can inspect all required financial/audit records; staff/customer cannot.
- all Phase 1-3 suites remain green.

MANDATORY GATES
- syntax check
- focused cash/reconciliation/timezone/report/outbox tests
- real-replica-set integration and concurrency suite
- full npm test
- bounded report load test with representative data
- npm audit production dependencies

DO NOT CHANGE
- No gold/payment-gateway/customer-payment capability.
- No customer passbook password changes.
- No new settlement economics.
- Do not begin staff/admin credential hardening or deletion lifecycle work.
- Do not bypass the journal for convenience.

PHASE COMPLETION RESPONSE
Return:
1. PHASE 4 CODE-READY: YES/NO.
2. Files/migrations/API changes.
3. Cash account definitions and reconciliation equations.
4. Timezone and pagination contracts.
5. Admin oversight endpoints and authorization matrix.
6. Outbox topics/worker behavior.
7. Exact command/test/load results.
8. Proof Phases 1-3 remain green.

Stop after Phase 4. Do not begin Phase 5.
```

### Phase 4 acceptance gate

- Cash custody and settlement payout reconcile from the journal.
- No correction path requires direct DB editing.
- Admin oversight is complete and access-controlled.
- Asia/Kolkata reports are deterministic.
- Outbox delivery is durable.

---

# PHASE 5 PROMPT — Authentication, Authorization and Account Lifecycle

```text
You are implementing AJ Gold Backend Corrective Phase 5 only.

PRECONDITION
- Start from completed Phase 4 with all earlier suites green.
- Do not alter financial semantics while hardening identity and authorization.

PHASE 5 GOAL
Harden staff/admin authentication, make authorization deny-by-default, preserve the intentional customer passbook credential policy, revoke sessions correctly, fail-close production CORS, and restore a compliant customer account-deletion lifecycle without erasing required financial records.

FROZEN IDENTITY RULES
- Customer accounts are created by authorized staff/admin; public self-registration remains disabled.
- Customer password is intentionally the predictable four-character passbook number. Preserve login compatibility and do not force complexity/MFA on this accepted customer path.
- Explicit customer password/reset validation must be internally consistent with the accepted four-character customer policy. Do not let controller say 4 while service requires 8.
- Staff/admin are privileged users and must use a separate stronger policy.
- Do not use Redis.
- Financial/audit/journal records required for accounting and legal retention must not be hard-deleted.

READ AND TRACE BEFORE EDITING
- src/services/auth.service.js
- src/services/customer.service.js
- src/services/staff.service.js
- src/controllers/auth.controller.js
- src/controllers/customer.controller.js
- src/controllers/admin.staff.controller.js
- src/routes/auth.routes.js
- src/routes/customer.routes.js
- src/routes/admin.routes.js
- src/middleware/auth.middleware.js
- src/middleware/loginRateLimit.middleware.js
- src/middleware/role.middleware.js
- src/middleware/staffPermission.middleware.js
- src/constants/staffPermissions.js
- src/models/user.model.js
- src/models/customer.model.js
- src/models/staffProfile.model.js
- src/app.js
- src/config/env.js
- src/services/audit.service.js
- Phase 4 admin/audit/journal endpoints
- all passwordHash, tokenVersion, JWT, permissions, CORS, login, logout, reset, inactive, and deletion references

REQUIRED IMPLEMENTATION
1. Define separate credential policies:
   - CUSTOMER: preserve the intentional four-character passbook-number credential and current staff-created account flow.
   - STAFF/ADMIN: consistent strong minimum, secure generated temporary credentials, forced first-change where practical, no static/demo credentials, and separate validation shared by controller/service/seed paths.
2. Fix the current customer password contract mismatch. Controller, service, tests, and API documentation must agree while preserving the four-character passbook behavior.
3. On every password reset/change, increment tokenVersion or revoke all applicable sessions atomically with the hash update.
4. Add a durable MongoDB-backed failed-login/account throttling model or equivalent approved persistent mechanism:
   - IP and normalized account/phone dimensions;
   - concurrency-safe atomic counters/windows;
   - bounded lockout/backoff;
   - reset on successful login;
   - works across app replicas/restarts;
   - privacy-conscious retention/TTL.
5. Configure proxy trust explicitly and safely for the intended production topology. Do not blindly trust all proxies.
6. Strengthen JWT/session validation for privileged roles: issuer, audience, expiry, token version/session identity, revocation, and key-rotation compatibility. Do not break accepted customer login without a migration/compatibility plan.
7. Add admin MFA or implement the complete backend-ready MFA enrollment/challenge/recovery workflow behind a fail-closed production requirement. Never log secrets/recovery codes.
8. Make staff permissions deny-by-default:
   - missing StaffProfile => deny;
   - missing permission => false;
   - align DEFAULT_STAFF_PERMISSIONS, model defaults, API schemas, middleware, and tests;
   - expose canViewReports and canSubmitCash in admin create/update validation;
   - default settlement/finalization permission to admin only;
   - persist modeled notes/joinedAt if still required.
9. Enforce active User and Customer status in all customer-sensitive and payment operations.
10. Make User/Customer name/phone/status changes transactional so identities cannot diverge.
11. Production CORS must fail closed:
    - require non-empty allowlist in production;
    - exact normalized origins;
    - no wildcard with credentials;
    - development defaults only outside production.
12. Mark authenticated/sensitive responses no-store where appropriate and ensure logs redact password/token/authorization data.
13. Restore account deletion as a controlled lifecycle:
    - customer request and cancel while pending;
    - admin list/detail/reject/approve/execute;
    - block or defer when active scheme, unsettled entitlement, custody, dispute, or legal hold exists;
    - anonymize allowed profile/PII after retention checks;
    - preserve immutable financial journal, settlement evidence references required by retention, and non-sensitive audit continuity;
    - record actors, reasons, timestamps, retention decision, and idempotency;
    - one pending request per customer enforced by partial unique index;
    - never cascade-delete financial records.
14. Use purpose-specific audit actions including LOGOUT, PASSWORD_RESET, MFA events, permission changes, deletion decisions, and anonymization.

MANDATORY TESTS
- default passbook customer can still log in with the intentional four-character passbook password.
- staff-created customer returns/handles the intended passbook credential exactly as before.
- explicit customer create/reset validation consistently follows the accepted customer policy.
- public registration endpoint remains absent.
- staff/admin weak credential is rejected by the privileged policy.
- password reset/change immediately invalidates old JWT/session.
- logout action is recorded correctly.
- persistent limiter survives simulated process instance change and handles concurrent failures atomically.
- IP-only and account-only bypass attempts are throttled appropriately.
- missing StaffProfile and missing permission deny access.
- every explicit false permission denies the matching endpoint.
- admin retains complete authorized oversight.
- staff cannot self-grant or exceed permissions.
- production boot fails with empty/wildcard credentialed CORS configuration.
- User/Customer update fault injection rolls back both records.
- inactive customer/user cannot perform protected actions or receive new payments.
- deletion request/cancel/review/approve/reject/execute/idempotent retry.
- deletion blocked by active/unsettled/held financial state.
- anonymization preserves journal integrity and retained audit links without exposing deleted PII.
- all Phase 1-4 financial tests remain green.

MANDATORY GATES
- syntax check
- focused auth/permission/session/deletion tests
- full HTTP authorization matrix tests
- real-replica-set transaction/concurrency tests
- full npm test
- npm audit production dependencies
- secret/log redaction scan

DO NOT CHANGE
- Never remove or strengthen away the intentional customer passbook password.
- Do not reintroduce public registration.
- Do not add gold or payment gateway features.
- Do not change settlement economics or journal calculations.
- Do not hard-delete financial/audit/journal history.
- Do not use Redis.

PHASE COMPLETION RESPONSE
Return:
1. PHASE 5 CODE-READY: YES/NO.
2. Separate customer vs privileged credential policies.
3. Permission matrix and defaults.
4. Session/limiter/MFA/CORS behavior.
5. Deletion state machine and retention behavior.
6. Files/migrations/API changes.
7. Exact test commands and counts.
8. Explicit proof that passbook login remains compatible and public registration remains absent.
9. Proof Phases 1-4 remain green.

Stop after Phase 5. Do not begin Phase 6.
```

### Phase 5 acceptance gate

- Accepted passbook credentials remain functional.
- Privileged identity controls are materially stronger.
- Permissions fail closed.
- Password resets revoke sessions.
- Production CORS fails closed.
- Deletion is compliant without destroying financial truth.

---

# PHASE 6 PROMPT — Migrations, Safe Operations, Observability and Release Engineering

```text
You are implementing AJ Gold Backend Corrective Phase 6 only.

PRECONDITION
- Start from completed Phase 5.
- All functional, financial, auth, and lifecycle tests from Phases 1-5 must be green.

PHASE 6 GOAL
Make the service operable and recoverable in production: versioned migrations, required-index and transaction gates, destructive-script isolation, environment validation, health/readiness, logging/metrics, CI, backup/restore/integrity tooling, and runbooks. Do not alter approved business logic.

FROZEN RULES
- No gold/payment-gateway/customer-payment functionality.
- Preserve all Phase 1-5 API and financial semantics.
- Preserve customer passbook credential behavior.
- Never connect audit/test/reset tools to production by default.
- Never use production syncIndexes as migration.
- Never report an operational gate as passed unless it actually ran against the required target.

READ AND TRACE BEFORE EDITING
- package.json and package-lock.json
- server.js
- src/app.js
- src/config/db.js
- src/config/env.js
- src/utils/transaction.js
- src/seed/resetDemo.js
- src/seed/seedCashVaultDemo.js
- src/seed/seedAdmin.js
- src/seed/seedDemo.js
- src/seed/verifyFinancialIndexes.js
- every migration added in Phases 1-5
- all models and declared indexes
- all health routes, console/morgan/logging, process signal, and environment references
- all deleteMany({}), dropDatabase(), syncIndexes(), known passwords, default phones, and destructive package scripts
- all list/report query indexes introduced by earlier phases

REQUIRED IMPLEMENTATION
1. Build/finalize one production migration runner:
   - ordered version IDs and checksums;
   - lease/lock preventing concurrent runners;
   - applied record with start/end/status/checksum;
   - restart-safe/idempotent steps;
   - dry-run/verify modes;
   - explicit failure on checksum drift;
   - no auto-deletion of conflicting legacy financial data.
2. Define a complete required-index manifest and verification command covering every critical unique/partial/TTL/query index from all phases. Verify key order, uniqueness, partial filter, TTL, and collation where relevant.
3. Add startup/release preflight for MongoDB transaction capability and replica-set topology. Readiness must fail closed if financial transactions cannot run.
4. Disable uncontrolled production auto-indexing; apply indexes only through migrations/release workflow.
5. Neutralize destructive demo tooling:
   - remove seedCashVaultDemo direct production package exposure or add its own independent production refusal;
   - require NODE_ENV != production;
   - require explicit ALLOW_DATABASE_RESET=true;
   - require database-name allowlist containing dev/demo/test;
   - require a second exact confirmation token bound to database name;
   - never embed/print known credentials;
   - refuse ambiguous MongoDB URI/database names.
6. Keep demo/test dependencies and scripts out of production runtime artifacts where practical.
7. Pin a supported Node engine and package-manager version. Add reproducible install/build/start commands.
8. Add strict production environment validation for JWT/session keys, CORS, MongoDB URI/database name, timezone, logging, object storage if used, notification worker, and owner-approved settlement formula version. Production must not start with weak/default placeholders.
9. Separate liveness and readiness:
   - liveness only confirms process/event loop;
   - readiness checks DB connectivity, transaction capability, migration/index state, and critical worker health with bounded timeouts.
10. Add graceful shutdown with connection draining, worker stop, DB close, and hard timeout.
11. Introduce structured redacted JSON logging with requestId, actor ID/role where appropriate, operation/clientRequestId, duration, status, and error code. Never log secrets, raw credentials, tokens, full evidence URLs, or unnecessary PII.
12. Add metrics/alerts for error rate, latency, DB pool, transaction retries/conflicts, idempotency conflicts, outbox lag/failures, login lockouts, cash reconciliation exceptions, settlement pending age, migration/index mismatch, and readiness failure.
13. Add an integrity scanner that detects at least:
    - cap violations;
    - payments outside scheme window;
    - multiple active schemes;
    - orphan User/Customer/Scheme/Payment records;
    - journal imbalance/duplicate business keys;
    - cash custody negative/mismatch;
    - settlement amount/evidence/state inconsistency;
    - pending/failed outbox age;
    - missing required indexes/migrations.
    Scanner must be read-only by default and exit non-zero on critical findings.
14. Add backup and restore runbooks/scripts with encryption, retention, restore verification, and a disposable-environment integrity check. Never claim a drill passed without restoring and verifying.
15. Add CI gates for clean install, syntax/lint, tests on a real/disposable replica set, migration empty/upgrade/idempotency, index verify, audit, integrity fixtures, build/package, and secret scanning.
16. Add README, environment example with placeholders only, deployment, rollback, incident response, migration, backup/restore, and reconciliation runbooks.
17. Preserve current API paths for compatibility. Do not rename everything to /api/v1 in this hardening phase; document future versioning instead.

MANDATORY TESTS/GATES
- production boot refuses missing/unsafe environment.
- production startup refuses standalone MongoDB/no transaction support.
- migration empty DB, representative legacy DB, interrupted rerun, concurrent runner, checksum drift, and idempotent rerun.
- required-index verifier detects missing/wrong unique/partial/TTL definitions.
- destructive scripts refuse production, ambiguous URI, non-demo DB, missing flag, and wrong confirmation.
- destructive scripts work only on explicit disposable demo DB fixture.
- liveness stays available during DB outage; readiness fails.
- graceful shutdown completes and hard timeout works.
- logger redaction tests.
- integrity scanner positive and adversarial fixtures.
- backup of disposable DB, destructive change, restore, index/migration verify, and financial integrity reconciliation.
- clean npm ci --ignore-scripts
- syntax/lint if configured
- full npm test on replica set
- npm audit --omit=dev --audit-level=high
- package/archive secret scan

DO NOT CHANGE
- Do not change financial formulas, window boundaries, settlement economics, permissions, or passbook behavior.
- Do not add product features.
- Do not run against a production database.
- Do not include .env, secrets, database dumps, node_modules, or logs in the deliverable archive.
- Do not hide failing gates by weakening tests or changing exit codes.

PHASE COMPLETION RESPONSE
Return:
1. PHASE 6 CODE-READY: YES/NO.
2. Migration/index/preflight architecture.
3. Destructive-tool safeguards.
4. Environment/runtime/health/shutdown changes.
5. Observability, scanner, backup/restore, CI, and runbooks added.
6. Exact commands and pass/fail/skip counts.
7. Any gate not executed and the precise reason; do not call it passed.
8. Proof all Phase 1-5 suites remain green.

Stop after Phase 6. Do not begin Phase 7.
```

### Phase 6 acceptance gate

- Production refuses unsafe configuration/topology/index state.
- Destructive scripts cannot touch non-demo databases.
- Migrations are explicit and repeatable.
- Integrity and recovery tooling works on disposable fixtures.
- Earlier business behavior remains unchanged.

---

# PHASE 7 PROMPT — Final Production Audit, Regression Closure and Code Freeze

```text
You are performing AJ Gold Backend Corrective Phase 7: final production audit and code-freeze verification.

PRECONDITION
- Start from the completed Phase 6 workspace.
- Do not re-extract any old ZIP.
- All phase reports and migrations must be present.
- This phase is verification-first. Do not refactor working financial code for style.

PHASE 7 GOAL
Audit every substantive file, run every real production gate, close only verified residual regressions, prove all 9 original P0 and 19 original P1 findings are resolved, and produce the final sanitized archive plus final audit report.

ORIGINAL BLOCKERS THAT MUST BE PROVEN CLOSED
P0:
1. caller-controlled/backdated/future payment date bypass;
2. contradictory first-six cutoff;
3. correction cap bypass;
4. admin ordinary-payment cap override;
5. post-maturity payment;
6. concurrent duplicate active schemes;
7. caller-invented cash settlement/no payout evidence;
8. destructive demo seed;
9. missing production DB migration/index/transaction/release gates.

P1:
1. omitted-timestamp idempotency;
2. fail-open staff permissions;
3. permission model/API mismatch;
4. non-cash reference/evidence;
5. mutable financial records;
6. cash correction dead end;
7. incorrect cash-position semantics;
8. User/Customer update divergence;
9. password reset session revocation;
10. non-production login limiter;
11. fail-open CORS;
12. incomplete admin oversight;
13. undefined business timezone;
14. critical missing uniqueness;
15. N+1/unbounded reporting;
16. lossy notifications;
17. employee-code race;
18. missing account-deletion lifecycle;
19. customer/API test coverage regression.

FROZEN FINAL CONTRACT
- Cash-only 11-month scheme; no gold logic.
- First period [start, +6 months), later period [+6 months, +11 months).
- First six any positive whole-rupee amount/count; later combined <= first combined.
- No ordinary cap override.
- No payment at/after maturity.
- Customer cannot create payments and public self-registration remains absent.
- Staff/admin record collections and method/reference.
- Settlement is server-computed from the owner-approved Phase 3 formula and requires evidenced payout/finalization.
- Intentional four-character passbook customer credential remains supported.
- Privileged auth is separately hardened.
- Admin has complete authorized oversight.

AUDIT METHOD
1. Inventory every substantive file and compare it with the Phase 6 completion report.
2. Read every changed production file, migration, test, package script, and runbook. Trace every financial write path end to end.
3. Search globally for bypasses and stale fields: paymentDate, effectivePaymentAt, sixMonthDate, maturityDate, overrideReason, limitOverride, settlementAmount, direct Payment update, deleteMany({}), dropDatabase, syncIndexes, fail-open permissions, CORS wildcard, tokenVersion, unawaited notification, hard-coded credentials, gold/rate/weight/purity/delivery, and CUSTOMER payment routes.
4. Verify every unique/partial/TTL index from model and migration definitions against a real disposable replica set.
5. Verify API authorization for every route and role, not just service functions.
6. Review dependencies and packaged output for secrets/unsafe artifacts.

MANDATORY AUTHORITATIVE GATES
- print node and npm versions and confirm they match the pinned versions.
- clean npm ci --ignore-scripts.
- syntax-check every JavaScript file.
- lint/static analysis if defined.
- run all unit tests.
- run all HTTP/integration tests against a real MongoDB replica set.
- run all concurrency/fault-injection tests.
- run migration tests: empty, representative legacy upgrade, interrupted rerun, concurrent runner, checksum drift, idempotent rerun.
- apply migrations to a disposable staging-like replica set.
- run required-index verification.
- run production environment/preflight tests.
- run the complete financial integrity scanner on clean and adversarial fixtures.
- run notification outbox retry/recovery tests.
- run report query-count/load test with representative data.
- run npm audit --omit=dev --audit-level=high.
- run secret scan and archive-content scan.
- perform disposable backup -> destructive fixture change -> restore -> migration/index verify -> integrity verify drill.
- package the final source without node_modules, .env, logs, caches, database files, credentials, or temporary artifacts.
- hash the final archive.

REGRESSION CLOSURE RULES
- If a gate fails, diagnose the actual root cause.
- Make the smallest in-scope correction and add a regression test.
- Re-run the focused test, affected phase suite, and then all mandatory gates.
- Do not weaken assertions, skip tests, widen permissions, re-add cap override, allow unsafe dates, disable transactions, or change business rules to make tests pass.
- Do not count MongoMemoryServer/runtime cancellation as a pass. Use the configured real disposable replica set.
- If an external credential/provider is unavailable, verify adapter behavior with contract tests and report the live credential gate as NOT EXECUTED. Do not fabricate success.
- If any P0/P1 remains open, final CODE-READY and PRODUCTION-READY must be NO.

REQUIRED FINAL REPORT
Create FINAL_AJ_GOLD_BACKEND_PRODUCTION_AUDIT.md containing:
1. archive name and SHA-256;
2. code-ready and production-ready verdicts;
3. section scores;
4. exact business contract;
5. each original P0/P1 with CLOSED/OPEN, implementation evidence, migration, and test evidence;
6. every command and exact test pass/fail/skip/cancel count;
7. migration/index/preflight results;
8. integrity and reconciliation results;
9. backup/restore drill result;
10. dependency/secret/package results;
11. any external/manual deployment gates still required;
12. complete file coverage statement;
13. final deployment decision.

REQUIRED COMPLETION RESPONSE
Return:
1. PHASE 7 CODE-READY: YES/NO.
2. PRODUCTION-READY: YES/NO.
3. Final score and open P0/P1/P2 counts.
4. Final archive path, size, and SHA-256.
5. Final audit Markdown path.
6. Exact commands and results.
7. Explicit confirmation that no gold logic/customer payment/public registration was introduced and the passbook credential remains compatible.
8. Manual production actions still needed, if any.

CODE FREEZE
If and only if every code gate passes and no P0/P1 remains, declare CODE FREEZE ALLOWED. Production readiness still requires actual deployment environment, migration, index, secret, backup/restore, monitoring, and rollback checks to have run successfully against the intended environment. Do not equate code-ready with production-ready.

Stop after the final report and sanitized archive. Do not add more features.
```

### Phase 7 acceptance gate

- Every original P0/P1 has implementation and test evidence.
- All authoritative gates have real results.
- Any unavailable live-environment gate is reported honestly.
- Final archive is clean and hashed.
- Code freeze is allowed only with zero open P0/P1 code defects.

---

# Expected phase outputs and archive naming

Use clear archive/report names so phases cannot be confused:

| Phase | Suggested archive | Required report |
| --- | --- | --- |
| 1 | `aj-gold-backend-phase-1-window-cap.zip` | `PHASE_1_WINDOW_CAP_REPORT.md` |
| 2 | `aj-gold-backend-phase-2-corrections-idempotency.zip` | `PHASE_2_CORRECTIONS_IDEMPOTENCY_REPORT.md` |
| 3 | `aj-gold-backend-phase-3-ledger-settlement.zip` | `PHASE_3_LEDGER_SETTLEMENT_REPORT.md` |
| 4 | `aj-gold-backend-phase-4-cash-reporting.zip` | `PHASE_4_CASH_REPORTING_REPORT.md` |
| 5 | `aj-gold-backend-phase-5-security-lifecycle.zip` | `PHASE_5_SECURITY_LIFECYCLE_REPORT.md` |
| 6 | `aj-gold-backend-phase-6-operations.zip` | `PHASE_6_OPERATIONS_REPORT.md` |
| 7 | `aj-gold-backend-final-production-candidate.zip` | `FINAL_AJ_GOLD_BACKEND_PRODUCTION_AUDIT.md` |

Each phase archive must exclude `.env`, secrets, credentials, `node_modules`, logs, caches, database files, coverage output, and previous ZIPs. Keep the phase report inside the archive and separately accessible.

# Final caution

Do not run Phase 3 until the cash settlement formula is explicitly confirmed. That is the only major business decision Cursor cannot safely derive from the backend. All other phases can follow the frozen contract in this document.
