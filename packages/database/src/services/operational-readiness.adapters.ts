// Sprint 27B — Operational Readiness Engine: Buyer & Vendor adapters (PR #121B)
// ---------------------------------------------------------------------------
// The ONLY place buyer / vendor knowledge lives. The kernel
// (operational-readiness.ts) is provider-neutral; each adapter declares the
// requirement set for ONE operational process and maps its own strongly-typed
// evidence to per-requirement facets via the shared classifyFacet — so
// satisfaction semantics stay identical to the Sprint 27 foundation.
//
// Two adapters ship in this PR: Buyer/Destination Setup and Vendor/Source Setup.
// Future readiness types (Creator, Campaign, Invoice, Employee Onboarding, AI
// Worker Deployment, …) plug in by registering another adapter here — no kernel
// change. Nothing in this file creates a buyer, a vendor, work, or a handoff.
// ---------------------------------------------------------------------------

import {
  classifyFacet,
  currentVersionApprovedAtScopes,
  registerReadinessAdapter,
  type EvaluatedRequirement,
  type EvidenceRef,
  type ReadinessAdapter,
} from './operational-readiness';
import type {
  RequirementCategory,
  ResponsibilityKey,
  WorkRequirementStatus,
  WaitingOnType,
  ApprovalScope,
  AssetLike,
  AssetVersionLike,
  ApprovalLike,
} from '../repositories/work-intelligence.policy';

// ---------------------------------------------------------------------------
// Shared evidence input & spec plumbing
// ---------------------------------------------------------------------------

// What a caller knows about ONE requirement. Absent ⇒ status 'unknown' ⇒ the
// requirement is missing (unknown NEVER satisfies). `required` is NOT settable
// here — applicability is derived by the adapter, never asserted by the caller.
export interface RequirementEvidenceInput {
  status?: WorkRequirementStatus;
  expiresAt?: Date | null;
  // When unsatisfied, the external party satisfaction depends on (buyer, vendor,
  // …). Setting this turns internally-missing work into an external WAIT.
  waitingParty?: WaitingOnType | null;
  ref?: EvidenceRef;
}

interface RequirementSpec {
  key: string;
  label: string;
  category: RequirementCategory;
  responsibility: ResponsibilityKey | null;
  // Applicability: 'always' required, 'optional' (never required — informational),
  // or 'contract' (required only when a contract applies to this subject).
  applicability: 'always' | 'optional' | 'contract';
  // Default external party for an unsatisfied requirement (overridable per-evidence).
  defaultWaitingParty?: WaitingOnType;
  // For 'asset_approval' requirements: the scopes that must ALL be approved.
  approvalScopes?: ApprovalScope[];
}

function requiredFor(spec: RequirementSpec, contractApplicable: boolean): boolean {
  if (spec.applicability === 'optional') return false;
  if (spec.applicability === 'contract') return contractApplicable;
  return true;
}

function reasonFor(
  facet: EvaluatedRequirement['facet'],
  status: WorkRequirementStatus,
  applicabilityReason: string,
): string {
  switch (facet) {
    case 'satisfied':
      return `satisfied (status '${status}')`;
    case 'waiting':
      return `awaiting external party (status '${status}')`;
    case 'expired':
      return 'satisfying evidence has expired';
    case 'revoked':
      return 'satisfying evidence was revoked';
    case 'blocked':
      return 'an active blocker is attached';
    case 'not_required':
      return applicabilityReason;
    default:
      return `no satisfying evidence (status '${status}')`;
  }
}

function evaluateSpec(
  spec: RequirementSpec,
  required: boolean,
  ev: RequirementEvidenceInput | undefined,
  now: Date,
  approvalSatisfied: boolean | undefined,
  applicabilityReason: string,
): EvaluatedRequirement {
  const status: WorkRequirementStatus = ev?.status ?? 'unknown';
  const waitingParty = ev?.waitingParty ?? spec.defaultWaitingParty ?? null;
  const facet = classifyFacet(
    {
      required,
      category: spec.category,
      status,
      expiresAt: ev?.expiresAt ?? null,
      approvalSatisfied,
      waitingParty,
    },
    now,
  );
  return {
    key: spec.key,
    label: spec.label,
    category: spec.category,
    required,
    facet,
    responsibility: spec.responsibility,
    waitingParty: facet === 'waiting' ? waitingParty : null,
    reason: reasonFor(facet, status, applicabilityReason),
    evidenceRefs: ev?.ref ? [ev.ref] : [],
  };
}

// ===========================================================================
// Buyer / Destination Setup
// ===========================================================================
// A destination is eligible to go live once its contract prerequisites (when a
// contract applies) and its operational specifications are all satisfied. When no
// contract applies, the contract requirements are NOT required and never fail
// readiness — applicability matters.
export const BUYER_PROCESS_TYPE = 'buyer_setup';

const BUYER_SPECS: readonly RequirementSpec[] = [
  { key: 'msa', label: 'Master Service Agreement (MSA)', category: 'contract', responsibility: 'CONTRACT_REVIEW', applicability: 'contract' },
  { key: 'io', label: 'Insertion Order (IO)', category: 'contract', responsibility: 'CONTRACT_REVIEW', applicability: 'contract' },
  { key: 'payout_terms', label: 'Payout terms', category: 'contract', responsibility: 'CONTRACT_REVIEW', applicability: 'contract' },
  { key: 'caps', label: 'Caps', category: 'contract', responsibility: 'CONTRACT_REVIEW', applicability: 'contract' },
  { key: 'destination_specs', label: 'Destination specifications', category: 'specification', responsibility: 'CALLGRID_SETUP', applicability: 'always' },
  { key: 'routing_specs', label: 'Routing specifications', category: 'specification', responsibility: 'CALLGRID_SETUP', applicability: 'always' },
  { key: 'operating_hours', label: 'Operating hours', category: 'specification', responsibility: 'CALLGRID_SETUP', applicability: 'always' },
  { key: 'required_tags', label: 'Required tags', category: 'specification', responsibility: 'CALLGRID_SETUP', applicability: 'always' },
  { key: 'call_requirements', label: 'Call requirements', category: 'specification', responsibility: 'CALLGRID_SETUP', applicability: 'always' },
  { key: 'other_setup_info', label: 'Other setup information', category: 'info', responsibility: 'CALLGRID_SETUP', applicability: 'optional' },
];

export type BuyerRequirementKey = (typeof BUYER_SPECS)[number]['key'];

export interface BuyerReadinessEvidence {
  // Whether a contract applies to THIS destination. Drives applicability of the
  // MSA/IO/payout/caps requirements. Default false ⇒ contract items not required.
  contractApplicable?: boolean;
  requirements?: Partial<Record<BuyerRequirementKey, RequirementEvidenceInput>>;
}

export const buyerReadinessAdapter: ReadinessAdapter<BuyerReadinessEvidence> = {
  processType: BUYER_PROCESS_TYPE,
  title: 'Buyer / Destination Setup',
  // Once setup prerequisites are met the destination is handed to optimization to
  // go live and be tuned.
  advanceResponsibility: 'CALLGRID_OPTIMIZATION',
  evaluate(evidence, now) {
    const contractApplicable = evidence.contractApplicable === true;
    return BUYER_SPECS.map((spec) => {
      const required = requiredFor(spec, contractApplicable);
      const applicabilityReason =
        spec.applicability === 'optional'
          ? 'optional setup information'
          : 'no contract applies to this destination';
      return evaluateSpec(
        spec,
        required,
        evidence.requirements?.[spec.key],
        now,
        undefined,
        applicabilityReason,
      );
    });
  },
};

// ===========================================================================
// Vendor / Source Setup
// ===========================================================================
// A source is eligible to run once its campaign is identified, its creative and
// landing/URL assets exist, and the current creative version is approved BOTH
// internally and by the buyer. Approvals are version-specific: a new version
// inherits nothing, so re-submitting resets approval and revokes readiness.
export const VENDOR_PROCESS_TYPE = 'vendor_setup';

const VENDOR_SPECS: readonly RequirementSpec[] = [
  { key: 'campaign', label: 'Campaign identified', category: 'info', responsibility: 'CREATOR_MANAGEMENT', applicability: 'always' },
  { key: 'creatives_submitted', label: 'Creatives submitted', category: 'specification', responsibility: 'CREATIVE_REVIEW', applicability: 'always' },
  { key: 'landing_pages', label: 'Landing pages', category: 'specification', responsibility: 'URL_REVIEW', applicability: 'always' },
  { key: 'urls', label: 'Destination URLs', category: 'specification', responsibility: 'URL_REVIEW', applicability: 'always' },
  { key: 'internal_approval', label: 'Internal creative approval', category: 'asset_approval', responsibility: 'CREATIVE_REVIEW', applicability: 'always', approvalScopes: ['internal'] },
  { key: 'buyer_approval', label: 'Buyer creative approval', category: 'asset_approval', responsibility: 'BUYER_APPROVAL_COORDINATION', applicability: 'always', approvalScopes: ['buyer'], defaultWaitingParty: 'buyer' },
  { key: 'stored_final_versions', label: 'Final versions stored', category: 'info', responsibility: 'CREATOR_MANAGEMENT', applicability: 'always' },
];

export type VendorRequirementKey = (typeof VENDOR_SPECS)[number]['key'];

// Version-specific approval facts for the creative asset under review. Reused
// verbatim from the Sprint 27 policy so "only the current version counts" and
// "a new version inherits nothing" hold identically here.
export interface VendorAssetEvidence {
  asset: AssetLike; // { id, currentVersion }
  versions: AssetVersionLike[]; // { id, workAssetId, version }
  approvals: ApprovalLike[]; // version-scoped decisions
}

export interface VendorReadinessEvidence {
  requirements?: Partial<Record<VendorRequirementKey, RequirementEvidenceInput>>;
  // The creative asset whose CURRENT version drives internal_approval and
  // buyer_approval. Absent ⇒ neither approval is satisfied (unknown).
  creativeAsset?: VendorAssetEvidence | null;
}

export const vendorReadinessAdapter: ReadinessAdapter<VendorReadinessEvidence> = {
  processType: VENDOR_PROCESS_TYPE,
  title: 'Vendor / Source Setup',
  // Once approved, the source is handed to optimization to activate.
  advanceResponsibility: 'CALLGRID_OPTIMIZATION',
  evaluate(evidence, now) {
    const a = evidence.creativeAsset ?? null;
    return VENDOR_SPECS.map((spec) => {
      const required = requiredFor(spec, /*contractApplicable*/ false);
      // asset_approval requirements consult version-specific approval truth.
      const approvalSatisfied =
        spec.category === 'asset_approval'
          ? currentVersionApprovedAtScopes(a?.asset, a?.versions ?? [], a?.approvals ?? [], spec.approvalScopes ?? [])
          : undefined;
      return evaluateSpec(
        spec,
        required,
        evidence.requirements?.[spec.key],
        now,
        approvalSatisfied,
        'optional',
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Registration. Importing this module registers both adapters. The barrel imports
// it for its side effect so the kernel can dispatch by process type.
// ---------------------------------------------------------------------------
registerReadinessAdapter(buyerReadinessAdapter);
registerReadinessAdapter(vendorReadinessAdapter);
