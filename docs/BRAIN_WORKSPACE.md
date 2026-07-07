# Brain Workspace (read-only)

Route: `/app/admin/brain`

The Brain workspace is the operating-intelligence surface of Loop OS. It is an AI
COO view, not a chatbot and not a prompt box. It answers a fixed set of questions:
what the Brain has observed, what needs attention, what it recommends, what evidence
supports those recommendations, what is still unknown, and what should be reviewed
next.

## Contract

- **Presentation / read-only only.** The page renders `force-dynamic` on the server
  and reads existing outputs. It performs no writes and no mutations.
- **No Brain invocation.** The workspace never runs Brain flows, never computes new
  `BrainActivity`, and never calls an LLM. The Brain computes on its own schedule;
  this surface only reads what has been persisted.
- **No backend, API, schema, Marketplace, or CallGrid changes.** The page composes
  existing readable repositories through the same `loadOrFallback` pattern the
  Marketplace workspaces use.
- **Never fabricate data.** Where the Brain has not yet persisted a readable output,
  the panel shows a premium waiting state that explains what will appear and when,
  rather than inventing numbers.

## Panels

1. **Executive Brain Summary** &mdash; the headline read of the business. Waiting
   state until a briefing is persisted.
2. **Brain Status** &mdash; standby indicator plus observed-signal, live-call, and
   evidence-source counts drawn from live operations and integrations.
3. **Recommendations** &mdash; severity-ranked, evidence-backed. Waiting state until
   diagnostics produce them.
4. **Risks** &mdash; critical and high findings first. Waiting state until observed.
5. **Opportunities** &mdash; upside the Brain believes is worth pursuing.
6. **Unknowns & Missing Evidence** &mdash; honest gaps. When sources are not
   connected, they are named here as evidence the Brain cannot yet see.
7. **Recent Brain Activity** &mdash; a readable feed of activity records when
   available; otherwise an empty state.
8. **Decision Queue** &mdash; human decisions the Brain has queued. Nothing is acted
   on automatically.

## Right rail

- Marketplace shortcut
- Integration status (connected / needs setup / errors)
- Recent activity
- Live calls

## Data: real vs waiting

Real, from existing repositories: organization resolution, live calls, live
activity, and provider/integration cards (with computed system health). The Brain
intelligence panels (summary, recommendations, risks, opportunities, decision queue)
show waiting states because a persisted, readable Brain briefing does not exist yet
&mdash; consistent with the Overview dashboard, which reports the Brain as Standby.
When a briefing becomes readable, these panels bind to it without any change to
backend behavior.
