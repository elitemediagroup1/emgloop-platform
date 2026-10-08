# People command center — production audit, 2026-10-08

This audit was performed from the deployed People screenshots, the merged source, and a real Gmail thread
used as a counterexample. It is deliberately narrower than a full browser QA pass: no claim is made that a
third-party browser extension was driven from this environment.

## Findings closed in this follow-up

1. **The page led with the wrong intelligence.** The organization CRM reading reported Party/Relationship
   inventory rather than what outreach needs. People now leads with an Outreach intelligence panel; the
   generic CRM-domain panel is removed from this surface.
2. **A Person detail was a navigation dead-end.** An explicit **Back to People** action is now present.
3. **There was no obvious path from a Person to a Relationship.** Person detail now exposes
   **Record relationship**, preselects that Person for the human-confirmed Relationship form, and returns
   to the Person after success. Loop never infers the Relationship kind or affiliation.
4. **Last touch was wrong after an inbound reply.** The projection previously considered only outbound
   Gmail and imported contact dates. Last touch now means the latest human Gmail touch in either direction.
5. **A reply was incorrectly treated as proof that a response was owed.** Gmail metadata proves direction
   and timing, not meaning. A latest human reply is now `REVIEW_REQUIRED / REPLY_CONTENT_UNKNOWN` with no
   fabricated overdue date. The existing body-aware Mail digest may suggest Reply, Waiting on them,
   Circle back, Review, or No immediate action.
6. **The Summary column was historical source text even when a live conversation existed.** When a current
   governed `mail.thread@1` digest exists, its minimized private summary is preferred. Source notes remain
   the fallback.
7. **Person detail did not summarize the actual conversation.** It now has a Conversation summary panel
   combining the viewer-private Mail interpretation with upcoming Calendar context.
8. **The Mail intelligence discovery window was too short for ordinary outreach.** A 14-day / 25-thread
   cap could drop a still-live "circle back next month" thread. Discovery is now bounded at 45 days / 100
   threads per authorized person; fingerprints and the existing AI budget still prevent unchanged replay
   and unbounded spend.

## Deliberate safety boundaries

- Mail bodies are still never copied into CRM or `work_messages`.
- AI summaries come only from the existing viewer-private Mail intelligence authority.
- AI suggestions do not silently set CRM state, create a Relationship or Opportunity, or change identity.
- If Mail content governance, consent, task activation or provider policy is not in force, the UI says the
  body-aware summary is unavailable. It does not fake one from headers.
- Exact Contact Point matching remains the only Gmail-to-Person link.
- Cadence timing remains deterministic. Its first outbound-send qualification is still direct-To metadata;
  until an explicit outreach-thread authority exists, the UI must not present that timing as semantic
  proof of the conversation's business state.

## Acceptance counterexample: Crumbl / Tayler Bushman

The latest known reply says 2026 campaigns are largely committed, Q1/Q2 2027 outreach is expected to begin
in roughly the next month, and Tayler can remain the intermediary. Metadata may state that Tayler replied;
it may **not** state "response overdue." With a body-aware Mail digest, the expected semantic suggestion is
a future circle-back / waiting posture unless the digest finds an actual obligation owed by the viewer.
