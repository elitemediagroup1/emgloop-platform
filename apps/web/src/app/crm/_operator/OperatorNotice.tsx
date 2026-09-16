// The two things every operator page says out loud.
//
// This surface is engineering tooling with a deliberately plain appearance. Saying
// so on the page is not modesty: somebody will screenshot it, and without this line
// the screenshot becomes "the new Loop design" in a conversation nobody was in.

export function OperatorNotice() {
  return (
    <p className="crm-sub" style={{ borderLeft: '3px solid var(--crm-faint, #999)', paddingLeft: '0.75rem' }}>
      <strong>Operator tooling.</strong> A deliberately plain surface so an authorized person can use the
      governed Party and Relationship authorities. It is not the product design, and it is meant to be
      replaced by one.
    </p>
  );
}

/** What just happened, in the authority's own words. Never a guess about why. */
export function Outcome({
  outcome, messages, detail,
}: {
  outcome?: string;
  messages: Record<string, string>;
  detail?: string;
}) {
  if (!outcome) return null;
  const message = messages[outcome] ?? outcome;
  const ok = outcome === 'RECORDED';
  return (
    <p className="crm-panel" role="status" style={{ borderLeft: `3px solid ${ok ? 'var(--crm-green, #16a34a)' : 'var(--crm-amber, #d97706)'}` }}>
      {message}
      {detail ? <><br />{detail}</> : null}
    </p>
  );
}
