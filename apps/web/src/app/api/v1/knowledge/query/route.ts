// EMG Loop — Verified Knowledge Service
// GET /api/v1/knowledge/query?platform=..&subject=..[&predicate=..]
//
// Contract-named alias of the claims subject-query route. LOOP_KNOWLEDGE_CONTRACT.md
// (the agreed PetsInMyCity <-> Loop integration contract) names the primary read
// path `/api/v1/knowledge/query`; the PetsInMyCity Loop provider
// (LoopKnowledgeStore._querySubject) calls exactly this path. The handler itself
// lives in ../claims/route.ts (same query params, same `{ ok, claims }` response,
// same auth + tenant scoping). We re-export it here so the contracted route name
// resolves without duplicating logic. No behavioural difference from /claims.

export { GET, POST, dynamic } from '../claims/route';
