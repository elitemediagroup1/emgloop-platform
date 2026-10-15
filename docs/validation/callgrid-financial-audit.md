# CallGrid financial audit

This operation reads one completed Eastern business day. It compares the canonical
provider reader's records with the organization's stored MarketplaceCall rows by
provider call ID. It does not ingest, replay, correct, certify, advance a checkpoint,
or change a financial value. No migration or new secret is required.

## First production run

After this PR is merged:

1. Open GitHub Actions in `elitemediagroup1/emgloop-platform`.
2. Select **Audit CallGrid Financials** → **Run workflow**, using **main**.
3. Enter organization `servicesinmycity-demo` and business date `2026-10-13`.
4. Download the `callgrid-financial-audit` JSON artifact from the completed run.

The workflow runs only on main, manually, using the existing
`DIRECT_DATABASE_URL` and `CALLGRID_API_KEY` Actions secrets. The requested organization
must already be listed in `ROUTINE_POLL_ORGANIZATIONS`, the existing polling scope;
this workflow does not extend that scope. Tests and installation
run before those credentials are exposed. Prisma logging is disabled, and caught
provider/database exception text is never printed. The artifact is retained for
seven days under the repository's existing Actions access controls; it contains
call IDs, campaign labels and financial amounts, with no caller contacts, recordings,
transcripts or raw payloads. The job summary shows counts, not individual IDs.

Local use, with credentials supplied through the environment:

```bash
npm run audit:callgrid-financials -- --organization servicesinmycity-demo --date 2026-10-13
```

## Reading the evidence

The JSON contains every inspected call's provider ID, campaign label, raw provider
decimal-dollar values, values produced by the current production mapper in cents,
stored Loop cents, differences, and field status. Differences use **Loop minus
provider canonical cents** with **zero-cent tolerance**. Raw sub-cent amounts are
kept to investigate rounding; the audit does not change the mapper or assume the
provider report UI sums the same rounded values.

- `DIFFERS`: at least one compared financial field or complete identity set differs.
- `INCONCLUSIVE`: a read was incomplete, a record was refused/unprojectable/outside
  the requested window, IDs repeated, a cap was reached, or a financial field was
  missing without an otherwise proven difference.
- `MATCHED_REPORTED_FIELDS`: these inspected fields and identities matched. This
  does **not** certify the report UI, all campaign permissions or historical coverage.
- `FAILED`: the operation did not finish. No comparison is available.

`UNKNOWN` is never treated as a zero or a match. Reported-value totals include
their known/missing counts. Net profit is summed only over calls carrying all
three financial fields; it is explicitly **net profit on complete calls**, not a
full-day total when some calls have incomplete economics.

The provider reader has a 100-page budget; the local read has a 10,000-call cap
plus one sentinel row. A partial read marks absences `UNVERIFIED_ABSENCE` rather
than declaring missing calls. One day uses the Time Authority's DST-aware,
half-open Eastern boundaries. Provider and database reads are not atomic; the
report records the requested read time and permits later postbacks to differ.

A green Actions job means the operation executed, not that the data matched.
Inspect the report's verdict, coverage and raw amounts before proposing corrections.

## Current production discrepancy being investigated

PR #384 is merged as `d252d4d4a8da16c45e1dced04cf061eb53244b03` and deployed
as Netlify `6acfd5e9676c8e7d1d94686c` (published October 14, 2026, 19:22 UTC).
The October 13 Eastern reports were observed after deployment:

| Metric | CallGrid report | Loop | Loop minus provider |
|---|---:|---:|---:|
| Revenue | $2,827.54 | $2,827.53 | −$0.01 |
| Payout | $2,305.27 | $2,305.26 | −$0.01 |
| Telco | $65.28 | $62.84 | −$2.44 |
| Net profit | $456.99 | $459.43 | +$2.44 |

The cost differences were Home Insurance −$1.12, FE Inbounds RTB −$1.20 and
Pest Control RTB −$0.12. Pest also accounted for both penny differences.
These are campaign-level observations, not call-level diagnoses. No historical
financial correction has been applied, and the cause of the penny differences
has not been established.

The October 14 production audit superseded the earlier assumption that the REST list endpoint lacked costs: it returned explicit costs for all 492 October 13 calls. All identities matched. Loop lacked 122 costs totaling $2.44, which the next routine reread filled. Source raw revenue/payout totals were $2,827.544702/$2,305.274702; the canonical per-call cent totals were $2,827.53/$2,305.26. Do not add an arbitrary cent or treat the report UI's aggregate rounding as a missing call.

On October 15, the October 14 completed-day UI still differed by $7.12 in known costs, while revenue and payout matched. Use **Correct CallGrid Costs** in preview mode to identify exact call-level changes before considering a correction. The audit remains read-only. The separate reviewed correction workflow is described in `callgrid-reconciliation-freshness.md`.
