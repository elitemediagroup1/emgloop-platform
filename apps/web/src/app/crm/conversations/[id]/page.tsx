import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadOrFallback, DbNotConfigured } from '../../../../demo/db-health';
import { crmRepos, resolveCrmOrganizationId } from '../../../../crm/crm-data';
import { requirePermission, hasPermission } from '../../../../auth/guard';
import {
  sendMessageAction,
  setConversationStatusAction,
  setConversationAssigneeAction,
} from '../../../../crm/conversation-actions';
import type { ConversationStatus } from '@emgloop/database';

// Conversation workspace — Sprint 8 (Conversations, Phase 3).
//
// The full message thread for one conversation, with a compose box that
// persists an agent message as a Message row (DB/timeline only — no real
// provider send), plus assignee and status controls backed by the real
// User picker. Read/write strictly through the conversations repository and
// guarded behind inbox permissions.

export const dynamic = 'force-dynamic';

const STATUSES: ConversationStatus[] = ['OPEN', 'PENDING', 'SNOOZED', 'CLOSED'];

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function actorClass(actorType: string): string {
  switch (actorType) {
    case 'HUMAN_AGENT': return 'crm-msg crm-msg-agent';
    case 'AI_AGENT': return 'crm-msg crm-msg-ai';
    case 'CUSTOMER': return 'crm-msg crm-msg-customer';
    default: return 'crm-msg crm-msg-system';
  }
}

export default async function ConversationWorkspacePage({
  params,
}: {
  params: { id: string };
}) {
  await requirePermission('inbox', 'view');
  const canWrite = await hasPermission('inbox', 'update');

  const result = await loadOrFallback(async () => {
    const organizationId = await resolveCrmOrganizationId();
    if (!organizationId) return { empty: true as const };
    const [workspace, assignees] = await Promise.all([
      crmRepos.conversationsInbox.getWorkspace(params.id),
      crmRepos.crm.listAssignees(organizationId),
    ]);
    return { empty: false as const, workspace, assignees };
  });

  if (!result.ok) return <DbNotConfigured />;
  if (result.data.empty || !result.data.workspace) notFound();

  const { workspace, assignees } = result.data;
  const w = workspace!;

  return (
    <>
      <div className="crm-breadcrumb">
        <Link href="/crm/conversations">← Inbox</Link>
      </div>

      <div className="crm-conv-head">
        <div>
          <h1 className="crm-h1">{w.subject}</h1>
          <p className="crm-sub">
            {w.customerId ? (
              <Link href={'/crm/customers/' + w.customerId} className="crm-cell-name">
                {w.customerName}
              </Link>
            ) : (
              w.customerName
            )}{' '}
            · {w.channel} · opened {fmt(w.createdAt)}
          </p>
        </div>
      </div>

      <div className="crm-conv-controls">
        <form action={setConversationStatusAction} className="crm-inline-form">
          <input type="hidden" name="conversationId" value={w.id} />
          <label className="crm-faint">Status</label>
          <select
            className="crm-select"
            name="status"
            defaultValue={w.status}
            disabled={!canWrite}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {canWrite ? <button className="crm-btn-sm" type="submit">Update</button> : null}
        </form>

        <form action={setConversationAssigneeAction} className="crm-inline-form">
          <input type="hidden" name="conversationId" value={w.id} />
          <label className="crm-faint">Assignee</label>
          <select
            className="crm-select"
            name="assigneeId"
            defaultValue={w.assigneeId ?? 'none'}
            disabled={!canWrite}
          >
            <option value="none">Unassigned</option>
            {assignees.humans.map((h) => (
              <option key={h.id} value={h.id}>{h.name}</option>
            ))}
          </select>
          {canWrite ? <button className="crm-btn-sm" type="submit">Assign</button> : null}
        </form>
      </div>

      <div className="crm-panel">
        {w.messages.length === 0 ? (
          <div className="crm-empty">No messages in this conversation yet.</div>
        ) : (
          <div className="crm-thread">
            {w.messages.map((m) => (
              <div key={m.id} className={actorClass(m.actorType)}>
                <div className="crm-msg-meta">
                  <span className="crm-msg-actor">{m.actorName}</span>
                  <span className="crm-faint">{fmt(m.sentAt)}</span>
                </div>
                <div className="crm-msg-body">{m.body}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {canWrite ? (
        <form action={sendMessageAction} className="crm-compose">
          <input type="hidden" name="conversationId" value={w.id} />
          <textarea
            className="crm-textarea"
            name="body"
            rows={3}
            placeholder="Write a reply… (saved to the timeline; no external send)"
            required
          />
          <div className="crm-compose-actions">
            <span className="crm-faint">
              Messages are persisted to the conversation timeline only.
            </span>
            <button className="crm-btn" type="submit">Send</button>
          </div>
        </form>
      ) : (
        <p className="crm-faint">You have read-only access to this conversation.</p>
      )}
    </>
  );
}
