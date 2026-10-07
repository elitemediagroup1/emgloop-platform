# CRM outreach import — the governed importer (CRM slice 5)

**Status (2026-10-07):** PR A is built (importer, provenance, reviewed mappings, local dry run, review
artifacts, a gated APPLY). Its migration `20261012000000_crm_import_provenance` is **not deployed**.
**Production APPLY and any production run are refused** until PR B (private S3 + GitHub OIDC) exists
and the gates in §9 have passed. The decisions are Matt's of 2026-10-07 (A–V, 23–31); the rules in
`crm-contact-points.md` §10 still bind.

## 1. What it is

The outreach directory is **evidence, not CRM authority**. The importer reads a structured CSV, applies
reviewed rules — route classifications, creator aliases, a status mapping — and composes the existing
governed writers. It never writes a CRM table itself:

| Write | Governed writer |
|---|---|
| Company / Person | `PartyService.create`, then `establish` with basis `MANUAL` (the operator's act) |
| Email / phone | `CrmContactPointService.add`, basis `IMPORTED`, `sourceRef = crm-outreach-import.v2:<row key>` |
| Opportunity | `CrmOpportunityService.create` (PD-F-11 CREATE) |
| BRAND / PRIMARY_CONTACT | `CrmOpportunityService.addParticipant` |

Each writer accepts a caller's transaction, so one import unit is atomic. The authorization, validation,
Party Reference check, audit row and outbox event are the same whether a writer runs alone or inside a
unit. Matching is the Contact Point authority's exact keyed-hash `match`, and nothing else.

## 2. Canonical source CSV (`crm-outreach-import.v2`)

**v2 (2026-10-07): `creator_alias` is optional.** EMG's CRM imports business contacts generally, not
only creator pursuits. A row without a creator may import its governed Company, Person and Contact Points,
but can never create an Opportunity (§4). v1 required a creator on every row; the version changed because
the same file now plans differently, and approvals bind the version.

UTF-8, RFC 4180 (quoted fields, doubled quotes, CRLF or LF, an optional BOM). The header names are
exact. An unknown or repeated column refuses the whole file, and so does a missing required one. No
workbook layout, tab names, merged cells or formatting are read: the spreadsheet is exported to this
CSV.

| Column | Required | Meaning / rule |
|---|---|---|
| `source_row_key` | yes | Stable across re-exports. `[A-Za-z0-9._:/-]`, 1–120 characters, no contact value. **Its identity across runs.** A duplicated key refuses every row that carries it. |
| `creator_alias` | no | The creator as the source labels them, resolved only through a reviewed alias. **Blank means no creator**: never inferred from a note, route, address, brand, title or domain, and the row can never create an Opportunity. |
| `route_key` | yes | The route (heading or mailbox group). Resolved only through a reviewed route classification. No contact value. |
| `source_status` | yes | The outreach status. **Not a stage.** Resolved only through the reviewed stage mapping. |
| `route_name`, `brand_name` | no | Review evidence only. Never used to name, find or match a Company. |
| `contact_name` | no | The contact's name, as the source has it. |
| `contact_name_verified` | no | `TRUE` / `FALSE` / blank. Only `TRUE` can make a Person. |
| `contact_kind` | no | `INDIVIDUAL` / `ROLE_INBOX` / blank. **Added to the recommended set:** without it, "shared inbox" and "named person" could only be guessed from an address. |
| `contact_title` | no | **Protected review artifact only.** Never stored (decision J). |
| `email`, `phone` | no | Normalized by the Contact Point authority. Phones must be E.164 (`+` and country code); anything else is `CONTACT_VALUE_INVALID`, never repaired. |
| `source_notes` | no | **Protected review artifact only.** Never stored. |
| `source_last_contacted_at` | no | An ISO date or instant. It becomes the Contact Point's `lastHumanContactAt`, which anchors retention. A future date refuses the row. |

**If the source system cannot provide a stable `source_row_key`**, the export must derive one
deterministically from fields that do not change when the sheet is re-sorted (for example, a stable
sheet row id). It must not use an email address. A key that collides is refused, never merged.

## 3. Reviewed configuration (`crm-outreach-import-config.v1`)

One JSON artifact holds three lists:

- `creatorAliases[]`: `{ alias, creatorPartyId }`;
- `routes[]`: `{ routeKey, classification, targetCompanyPartyId?, proposedCompanyName?, representedBrandPartyId?, representedBrandRouteKey? }`;
- `stageMapping[]`: `{ sourceStatus, action: OPPORTUNITY | CONTACTS_ONLY | EXCLUDE, category?, stage? }`.

**Aliases and routes are persisted** in `crm_import_creator_aliases` and `crm_import_route_mappings`, by
an OWNER/ADMIN, through `CrmImportConfigService`:
- The whole file is checked first, and then everything is recorded in one transaction, or nothing is.
- The checks: shape, key collisions, and every Party it names. A creator must be an established,
  current PERSON. A target or represented brand must be an established, current COMPANY. Another
  tenant's id is NOT_FOUND.
- The tables are append-only. A changed mapping is refused unless the operator passes `--replace`, and
  replacing retires the old row and writes a new one.
- **The stage mapping is not persisted.** It travels with the run, inside the configuration fingerprint.

**Normalization** of aliases, route keys and statuses: NFKC, trimmed, inner whitespace collapsed,
lower-cased. Nothing else: no punctuation stripping, no accent folding, no similarity. Two entries that
normalize to the same key are refused.

### Route classifications

| Classification | Its own Company | Pursuit brand |
|---|---|---|
| `BRAND_COMPANY` | Its target, or a proposal named by the reviewer | Itself |
| `AGENCY`, `PARENT_COMPANY` | Its target, or a proposal | Only an explicit represented brand |
| `ROLE_INBOX_ROUTE` | None | An explicit represented brand. Its addresses are `ROLE_INBOX` on that brand. |
| `PERSONAL_GENERIC` | None | An explicit represented brand. With none, the row has no Company context and nothing is created. |
| `CREATOR_ROUTE`, `INTERNAL`, `UNKNOWN` | None | None. Nothing is created. |
| *(unmapped)* | — | `ROUTE_UNMAPPED`: blocked. |

A represented brand is either an existing Company id or a `BRAND_COMPANY` route key, which may itself
be a proposal.

## 4. The rules the plan applies

- **Company.** Selected only by a route's explicit target, or by an import key from an earlier APPLY.
  Otherwise the reviewer's proposal is used. There is never name, domain or fuzzy matching: two routes
  proposing the same name are two Companies.
- **Person.** Only for `contact_kind = INDIVIDUAL` with `contact_name_verified = TRUE` and a real name.
  Blank, placeholder and team names (`Name not verified`, `Unknown`, `N/A`, `Team`, …) never qualify, and
  nothing is read from an address.
  - A Person is reused only by an exact, single, current Contact Point `MATCH`, or by its import key.
  - Within the file, one Person key covers the rows that share a verified address, and they must carry
    the same name.
- **Contact Points.**
  - `INDIVIDUAL` attaches to the Person.
  - `ROLE_INBOX` (declared, or on a `ROLE_INBOX_ROUTE`) attaches to the Company.
  - Anything else attaches to the Company as `UNATTRIBUTED`.
  - A value two rows send to different places is `CONTACT_VALUE_CONFLICT`.
  - Any match outcome other than `NO_MATCH`, or a `MATCH` on the intended Party, is review. Examples are
    `HELD_BY_ANOTHER_PARTY`, `CONFLICT` and `TYPE_MISMATCH`.
- **AFFILIATION: never.** Not from an email domain, a route, a title, or a BRAND + PRIMARY_CONTACT pair.
  No Relationship is created (decision R), and `relationshipId` is always null.
- **Rows without a creator (v2).** They follow every rule above for their Company, Person and Contact
  Points, and never feed a pursuit.
  - Status `CONTACTS_ONLY`: the contacts are imported (`CONTACTS_ONLY`).
  - Status maps to `OPPORTUNITY`: the whole row is held as `OPPORTUNITY_REQUIRES_CREATOR`. An
    Opportunity needs a creator and none is invented, so nothing the row would cause is written until a
    person resolves it.
  - Unmapped, excluded or unrouted: the same gates as any row.
  - A creator-less row beside a creator pursuit on the same brand never joins it: its Person is not a
    PRIMARY_CONTACT of that pursuit.
- **Opportunity grain (decision D):** one per **creator × governed brand Company**, from rows that name
  a creator.
  - The title is exactly `<Creator display name> × <Brand Company display name>`.
  - All its rows' governed People are PRIMARY_CONTACTs; none is chosen over another.
  - BRAND is the brand Company.
  - The owner is null, so it reads as **Unassigned** (decision I).
  - Nothing is creator-visible, and the first transition has no note.
  - An Opportunity that already exists for that creator × brand, and was not created by the importer,
    is `EXISTING_PURSUIT_REVIEW`.
- **Stage gate (decision F).** A status with no mapping is `STAGE_MAPPING_REQUIRED`, and blocks every
  write the row would cause. Rows of one pursuit mapping to different stages are `STAGE_CONFLICT`.
  `CONTACTS_ONLY` rows feed no Opportunity; `EXCLUDE` rows import nothing. **No mapping is decided in
  this slice.** The directory statuses (Not due, Historical, Other hold, Human reply–hold, Excluded,
  Pending draft) map to nothing until Matt maps them from the real status inventory.

## 5. Provenance (migration `20261012000000_crm_import_provenance`)

| Table | Holds |
|---|---|
| `crm_import_runs` | Mode, state, importer version, source SHA-256, configuration fingerprint, plan digest, counts, failure codes, operator, times, and the APPLY lock |
| `crm_import_entries` | Per row: line, row key, **keyed** row fingerprint, mapping ids, outcome, review code, planned actions (kind/classification/action only), and the resulting subject ids |
| `crm_import_approvals` | An OWNER/ADMIN's approval of one real dry run (a foreign key), binding its source, version, configuration and plan. Claimed by at most one APPLY run. |
| `crm_import_keys` | **The idempotency authority.** Deterministic key → the subject a governed writer created, claimed in the same transaction |

**Never stored here:** an email, a phone number, a contact name, a title or a note.

**References are real foreign keys:** approval → its dry run, APPLY run → the approval it claimed (UNIQUE), import key → its run, entry → its run. All are NO ACTION: one provenance row never erases another by cascade, and only deleting the organization removes them, in one statement. An import key's CRM subject id is deliberately not a foreign key, so provenance never blocks a governed CRM lifecycle.

## 6. Flow

1. **record-config** (OWNER/ADMIN): reviewed aliases and routes.
2. **dry-run** (EMPLOYEE+):
   - plans the file and records the run and its entries;
   - writes **no CRM row**;
   - writes two review artifacts, both mode 0600 and outside the repository:
     - the ordinary one: decisions, references and names;
     - the PROTECTED one: adds status, route and brand text, email, phone, title and notes.
3. **approve** (OWNER/ADMIN): one dry run.
4. **apply** (OWNER/ADMIN), in order:
   - re-plans, and refuses unless source, importer version, configuration and plan all equal the
     approval;
   - refuses an approval any APPLY run has already claimed. **An approval is consumed when an APPLY
     run claims it**, whatever that run's outcome: succeeded, failed or abandoned. Inserting the run is
     the claim, and `crm_import_runs.approvalId` is UNIQUE, so two concurrent claims cannot both win;
   - takes the organization's lock: a unique key in the database;
   - runs the units: Companies (each with its addresses), then People (each with theirs), then
     pursuits (Opportunity + BRAND + PRIMARY_CONTACTs). Each unit is one transaction.

A unit the governed writers refuse rolls back whole: no Company without its addresses, and no
Opportunity without its brand.

## 7. Idempotency and concurrency

- **Keys claimed with the subject.** Every created subject is claimed under its key, in the
  subject's own transaction:
  - `COMPANY route:<key>`;
  - `PERSON email|phone:<keyed hash>` or `row:<key>`;
  - `OPPORTUNITY <creator>|<brand>`.

  A retried, resumed or concurrent unit reuses the subject, or loses the unique race and rolls back.
- **Duplicates already present.** A Contact Point or Participant that is already there is the governed
  writer's `DUPLICATE`: a no-op.
- **Unchanged rows** fully applied are `ALREADY_IMPORTED_UNCHANGED`.
- **Changed rows** are `SOURCE_ROW_CHANGED`: review, never a silent update.
- **One APPLY at a time.** `crm_import_runs.applyLockKey` is unique per organization. A dead process's
  lock is released by `abandon` (OWNER/ADMIN).
- **One APPLY per approval.** An approval is consumed when an APPLY run claims it. A FAILED or
  ABANDONED run keeps its approval consumed. After a partial or interrupted APPLY, recovery is always a
  fresh dry run, human review and a NEW approval; that completes exactly the remaining work.
- **Not the authority.** Workflow concurrency and process memory are not; the database is.

## 8. Who may act (decision T: RBAC resource `crmImports` + `CRM_IMPORT_ACT_ROLES`)

| Act | Roles |
|---|---|
| VIEW (the coarse gate) | OWNER, ADMIN, MANAGER, EMPLOYEE, READ_ONLY |
| DRY_RUN | OWNER, ADMIN, MANAGER, EMPLOYEE |
| MAP_CREATOR_ALIAS, MAP_ROUTE, APPROVE_APPLY, APPLY | OWNER, ADMIN |

AI_EMPLOYEE is hard-denied (no Permission row can grant it), and CREATOR holds nothing. An APPLY also
needs every underlying grant, such as `identityResolution:approve` to establish a Party.

## 9. Gates before any production import

The steps run in this order:
1. migration reviewed, merged, deployed;
2. PR B (private S3 + dedicated OIDC read role) built, reviewed and merged;
3. the private source uploaded;
4. a real dry run;
5. human review of both artifacts;
6. **stage mapping approved**;
7. route and creator mappings approved;
8. explicit APPLY approval;
9. a controlled first import;
10. CRM UI verification;
11. the scaled import.

**Production APPLY is refused in code today:** `executionTarget` must be `LOCAL_TEST`, and the database
host must be local.

**What Matt must provide for the first real dry run:**
- the structured CSV in §2, with stable row keys, `contact_kind` and `contact_name_verified` filled, and
  phones in E.164;
- the reviewed aliases and routes for every creator label and route in it;
- the stage mapping, decided from the status inventory.

**Before PR B runs a dry run against production data,** the importer's process must be keyed with
production's `COGNITIVE_HASH_SECRET`. Exact Contact Point matching compares keyed hashes.

## 10. The production path (PR B, 2026-10-07)

**Implemented. Not deployed. Procedure:** `docs/runbooks/crm-outreach-import.md`.

**Where things live:**
- **Bucket:** `loop-crm-import-080891698678`, with three prefixes:
  - `crm-import/source/`: sources, uploaded by a human;
  - `crm-import/config/`: reviewed configurations;
  - `crm-import/review/run-<id>/`: review artifacts.
- **Template:** `infra/connections/access/crm-import-source-access.yaml`, deployed by Matt.
- **The one identity, `loop-crm-import-github-production`:**
  - assumable only by `connections-production`;
  - reads sources and configs;
  - writes review files;
  - nothing else.

**The workflow, `CRM Outreach Import`:**
- **Modes:** `validate`, `inventory`, `record-config` and `dry-run`. There is no mode that writes
  canonical CRM records.
- **Where it runs:** from `main` only, in `connections-production`, for the one organization the
  environment pins.
- **Before parsing:** it verifies the object's SHA-256 over its bytes.
- **The database URL** is read with the unchanged migrate role.
- **The identifier key** comes from the repository secret, to the import step only.
- **Review files** go to the private prefix, and the runner's copy is removed.

**The command's production target:**
- read and dry-run only;
- inside GitHub Actions on `refs/heads/main`;
- with `--expected-sha256`, `--importer-version` and `--source-ref s3:<key>:v:<version>`.

**Two more safeguards:**
- **The dry run checks the identifier key.** It refuses with `HASH_KEY_MISMATCH` if an existing
  Contact Point was hashed under a different key.
- **The importer version.** PR B left it at `crm-outreach-import.v1`, since it wired infrastructure
  and a safety precondition only. The optional-creator change (2026-10-07) made it
  `crm-outreach-import.v2`, because the same file now plans differently.

## 11. Not built

- **Production APPLY and approval.** A separate reviewed commissioning change, after the real dry
  run is reviewed and the stage mapping approved.
- **Alias and route administration UI.**
- **A governed job-title / employment / affiliation authority.**
- **A governed Opportunity-note authority.**
- **An XLSX-to-canonical-CSV transformation.** It is written once the real source's layout is known.
