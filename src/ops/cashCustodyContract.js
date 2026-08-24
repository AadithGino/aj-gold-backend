/**
 * Canonical cash-custody contract for AJ Gold backend.
 *
 * Authoritative source: immutable FinancialJournal entries on STAFF_CASH_CUSTODY and VAULT.
 * Staff custody balance is derived ONLY from journaled events with metadata.staffId (or actor for staff collections).
 *
 * Derived aggregates (getStaffCashInHand) rebuild from:
 * - effective cash collections by staff (via payment ledger + corrections)
 * - ACTIVE cash submissions only (REVERSED submissions are excluded)
 *
 * Reconciliation compares journal custody to derived aggregate; mismatches are integrity defects.
 */
const CANONICAL_CUSTODY_SOURCE = "FinancialJournal";

module.exports = {
  CANONICAL_CUSTODY_SOURCE,
};
