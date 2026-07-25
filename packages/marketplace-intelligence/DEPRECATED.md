# DEPRECATED — do not build on this package

`@emgloop/marketplace-intelligence` is **deprecated and slated for removal**.

- **Zero importers.** Nothing in the repo imports it.
- **Does not typecheck** (62 pre-existing errors); it is excluded from the
  Netlify build (which filters to `@emgloop/web`).
- **Superseded** by `packages/intelligence` (the live Executive Brain +
  marketplace sensor), which is the canonical intelligence implementation.

Classified `DEPRECATE` during the Loop Cognitive Architecture consolidation audit
(see `docs/architecture/loop-cognitive-architecture.md` → Consolidation). It was
**not deleted** in that increment because deletion is an independent change (one
objective per branch); it is safe to remove in a dedicated cleanup PR once
confirmed no external tooling references it.

New intelligence work belongs in `packages/intelligence` and `packages/brain`
(type contracts) — never here.
