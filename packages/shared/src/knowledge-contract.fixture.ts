// @emgloop/shared — Verified Knowledge contract FIXTURE (kg.v1)
//
// A small, representative Austin-SHAPED import batch used by the contract test to
// prove that Loop accepts a payload built to LOOP_KNOWLEDGE_CONTRACT.md without
// requiring the PetsInMyCity repository at runtime. This is illustrative test
// data ONLY — it is NOT real production Austin knowledge and is never imported
// into production by this PR.
//
// Source of contract shape: petsinmycity @ feature/durable-knowledge-storage,
// docs/implementation/LOOP_KNOWLEDGE_CONTRACT.md (contract_version kg.v1).

import { KNOWLEDGE_CONTRACT_VERSION, type KnowledgeImportBatch } from './knowledge';

export const CONTRACT_FIXTURE_BATCH: KnowledgeImportBatch = {
  contract_version: KNOWLEDGE_CONTRACT_VERSION,
  sources: [
    {
      id: 'src_city_of_austin_animal_services',
      tier: 1,
      kind: 'government',
      url: 'https://www.austintexas.gov/department/animal-services',
      accessed: '2026-01-10',
      quote: null,
      captured_by: 'editorial:austin',
    },
  ],
  entities: [
    {
      id: 'ent_austin_animal_center',
      type: 'organization',
      name: 'Austin Animal Center',
      aliases: ['AAC'],
      status: 'active',
      confidence: 'high',
      verification: 'verified',
      safety_critical: false,
      attributes: { city: 'Austin', state: 'TX', kind: 'municipal_shelter' },
    },
  ],
  claims: [
    {
      id: 'clm_aac_intake_policy',
      subject: 'ent_austin_animal_center',
      predicate: 'accepts_stray_intake',
      value: { answer: true, notes: 'municipal open-intake shelter' },
      confidence: 'high',
      verification: 'verified',
      safety_critical: false,
      valid_from: '2026-01-01',
      valid_until: null,
      expires: null,
      review_by: '2026-07-01',
      note: null,
    },
  ],
  relationships: [
    {
      edge: 'operated_by',
      from: 'ent_austin_animal_center',
      to: 'ent_city_of_austin',
      confidence: 'high',
    },
  ],
  entity_sources: [
    { entityId: 'ent_austin_animal_center', sourceId: 'src_city_of_austin_animal_services' },
  ],
  claim_sources: [
    { claimId: 'clm_aac_intake_policy', sourceId: 'src_city_of_austin_animal_services' },
  ],
};

/** A deterministic idempotency key for the fixture batch (dataset id + version). */
export const CONTRACT_FIXTURE_IDEMPOTENCY_KEY = 'petsinmycity:austin:kg.v1:fixture-0001';
