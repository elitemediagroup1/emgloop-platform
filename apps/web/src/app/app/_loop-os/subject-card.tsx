// The Subject Display System, drawn (handoff 2026-09-16, pp. 13-14).
//
// One component for every density, so a Person looks like a Person in a table row,
// a list card, a rail and a record header. The model (`crm/subject-display.ts`)
// decides what is said; this decides only how it is laid out.
//
//   row       compact subject row: name, type or state, one context line
//   card      standard card: identity, context, current state, navigation
//   context   context card for rails and drawers: why it is here, its role, a change
//   featured  record header and mobile summary: identity, state, critical context
//
// No image is ever rendered: a photo never establishes identity, and initials or a
// neutral mark always work. A Relationship is one subject: its sides are named in its
// own card ("EMG ↔ Denise K"), never drawn as two Party cards.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { subjectInitials, type SubjectDensity, type SubjectDisplay, type SubjectKind } from '../../../crm/subject-display';
import { StatePill } from './record';

const AVATAR_CLASS: Record<SubjectKind, string> = {
  PERSON: 'lx-avatar',
  COMPANY: 'lx-avatar lx-avatar--company',
  RELATIONSHIP: 'lx-avatar lx-avatar--relationship',
  WORKSPACE: 'lx-avatar lx-avatar--workspace',
  INTAKE: 'lx-avatar lx-avatar--intake',
  UNRESOLVED_ACTIVITY: 'lx-avatar lx-avatar--unresolved',
};

export function SubjectAvatar({ subject, size }: { subject: Pick<SubjectDisplay, 'kind' | 'name' | 'named'>; size?: 'sm' | 'lg' }) {
  const initials = subjectInitials(subject.named ? subject.name : null, subject.kind);
  return (
    <span className={AVATAR_CLASS[subject.kind] + (size ? ` lx-avatar--${size}` : '')} aria-hidden="true">
      {initials}
    </span>
  );
}

export function SubjectCard({
  subject,
  density,
  headingLevel,
  children,
}: {
  subject: SubjectDisplay;
  density: SubjectDensity;
  /** The record header's subject is the page heading. */
  headingLevel?: 'h1' | 'h2' | 'h3';
  children?: ReactNode;
}) {
  const Name = headingLevel ?? 'p';
  const nameClass = 'lx-subject__name' + (subject.named ? '' : ' is-placeholder');
  const typeLine = (
    <span className="lx-subject__type">
      <b>{subject.typeLabel}</b>
      {density === 'row' ? <span>{subject.state.label}</span> : <StatePill state={subject.state} />}
    </span>
  );
  const contextLine = [subject.context, subject.affiliation].filter(Boolean).join(' · ');
  const fact = subject.fact && density !== 'row' ? (
    <p className={`lx-subject__fact lx-subject__fact--${subject.fact.knowledge}`}>{subject.fact.text}</p>
  ) : null;

  const body = (
    <div className="lx-subject__body">
      <Name className={nameClass}>{subject.name}</Name>
      {density === 'featured' ? null : typeLine}
      {contextLine ? <p className="lx-subject__line">{contextLine}</p> : null}
      {density === 'featured' ? (
        <span className="lx-subject__type">
          <b>{subject.typeLabel}</b>
          <StatePill state={subject.state} />
        </span>
      ) : null}
      {fact}
      {density === 'card' && subject.action ? (
        subject.action.href ? (
          <span className="lx-subject__go">{subject.action.label} →</span>
        ) : (
          <span className="lx-subject__go lx-subject__go--disabled">{subject.action.unavailableReason ?? 'Not available to you'}</span>
        )
      ) : null}
      {children}
    </div>
  );

  const avatar = <SubjectAvatar subject={subject} size={density === 'featured' ? 'lg' : density === 'context' ? 'sm' : undefined} />;
  const cls = `lx-subject lx-subject--${density}`;
  const href = subject.action?.href ?? null;
  // Rows, cards and context cards navigate as a whole; the featured block is the page itself.
  if (href && density !== 'featured') {
    return (
      <Link className={cls} href={href} aria-label={subject.action?.label} data-subject-kind={subject.kind}>
        {avatar}
        {body}
      </Link>
    );
  }
  return (
    <div className={cls} data-subject-kind={subject.kind}>
      {avatar}
      {body}
    </div>
  );
}
