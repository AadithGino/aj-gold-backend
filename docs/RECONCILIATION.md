# Reconciliation Runbook

## Daily checks

1. `npm run integrity:scan` (or scheduled job using same scanner)
2. Admin `/api/admin/reconciliation/exceptions`
3. Review outbox lag via `/api/health/metrics` and admin outbox list

## Staff custody mismatch

- Scanner code: `STAFF_CUSTODY_MISMATCH`
- Compare journal custody vs aggregate cash in hand
- Investigate unreversed submissions or missing journal entries

## Settlement pending age

- Scanner code: `SETTLEMENT_PENDING`
- Review schemes with workflow not `FINALIZED`
- Ensure payout evidence exists before finalization
