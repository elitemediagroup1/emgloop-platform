import 'server-only';

// Sprint 30 — Executive Workspace data loader (/app/admin).
//
// The owner's home answers three questions, in this order:
//   1. What needs attention today?   -> attention[]  (decisions, oldest first)
//   2. What should happen next?      -> nextAction + work buckets
//   3. What happened recently?       -> recentActivity + completedToday
//
// Non-negotiables carried forward from Sprint 25 and unchanged: identity is
// ALWAYS derived from the authenticated session (never URL/client input); every
// read is scoped to session.organizationId; no new engine, no demo store, no
// mock providers, NO Prisma schema change, no fabricated data.
//
// WHAT THIS LOADER DELIBERATELY DOES NOT PROVIDE, AND WHY
//
//   "Overdue work" — NOT REPRESENTABLE. Neither WorkInstance nor WorkStage has
//   a due date (see packages/database/prisma/schema.prisma). There is no
//   deadline to be late against, so nothing here claims one. The honest signal
//   we CAN derive is age: how long a stage has been ready/waiting, measured
//   from WorkStage.startedAt. It is surfaced as "waiting 6d" — a fact — and
//   never as "overdue", which would imply a commitment that was never made.
//
//   "Work requiring approval" — NOT WIRED. BlueprintStage.requiresApproval is a
//   TEMPLATE flag; createWorkFromBlueprint does not copy it onto the WorkStage
//   it creates, WorkStage has no such column, and the 'approval_needed'
//   notification type is declared in WORK_NOTIFICATION_TYPES but never emitted
//   by any code path. There is therefore no approval state to read. Rendering an
//   "Awaiting your approval" bucket would be fabricated functionality. It is
//   omitted until the runtime actually supports it.
//
// Both gaps need a schema change + migration and are tracked as follow-ups.

import { prisma, createRepositories, roleLabel } from '@emgloop/database';
import type {
  WorkInstance,
  WorkStage,
  WorkNotification,
  AuditView,
} from '@emgloop/database';

import { requireWorkspace } from '../../../workspaces/guard';
import { hasPermission } from '../../../auth/guard';

const repos = createRepositories(prisma);

// A conversation is "stalled" when nothing has been said on it for longer than
// this. It is a product threshold, not a computed insight — so every label it
// produces states the rule out loud ("no reply in 3d") rather than asserting an
// opinion ("needs attention"). Changing this number changes only what we choose
// to surface; it never changes what the data says.
const STALL_HOURS = 24;

// The four selectable work buckets. Also the accepted ?filter= values.
export type WorkFilter = 'assigned' | 'ready' | 'blocked' | 'completed';
export const WORK_FILTERS: WorkFilter[] = ['assigned', 'ready', 'blocked', 'completed'];

export function parseWorkFilter(v: string | undefined | null): WorkFilter {
  return (WORK_FILTERS as string[]).includes(v ?? '') ? (v as WorkFilter) : 'assigned';
}

// ---------------------------------------------------------------------------
// Typed shape returned to the page.
// ---------------------------------------------------------------------------
export interface WorkspaceHomeHeader {
  greeting: string;
  displayName: string;
  organizationName: string;
  dateLabel: string;
  roleLabel: string;
}

export interface NextActionView {
  workInstanceId: string;
  title: string;
  stageName: string;
  verb: string;   // real, action-specific label: Resume | Complete | Open
  href: string;
}

export interface WorkSummary {
  assignedToMe: number;
  readyNow: number;
  waitingBlocked: number;
  completedToday: number;
}

export interface MyWorkItem {
  workInstanceId: string;
  title: string;
  stageName: string;
  status: string;        // ready | in_progress | pending | completed
  verb: string;          // Open | Resume | Review | Complete
  assignedLabel: string; // human "assigned"/"waiting" line from real timestamps
  href: string;
}

export interface NotificationView {
  id: string;
  title: string;
  body: string;
  kind: string;          // notification.type, for icon selection
  createdAtIso: string;
  href: string | null;
}

/**
 * One concrete thing that needs a decision from the owner today.
 *
 * Every field traces to a row. 'reason' states the REAL RULE that put the item
 * here ("ready 3d ago, no owner"), never a judgement ("important"). Items are
 * ranked purely by how long they have been waiting — the oldest neglected thing
 * is first — which is a fact about the data, not a priority we invented.
 */
export interface AttentionItem {
  key: string;
  kind: 'work' | 'conversation' | 'request' | 'invitation';
  kindLabel: string;
  title: string;
  reason: string;
  href: string;
  cta: string;
}

export interface ActivityItem {
  id: string;
  label: string;
  actorName: string;
  category: string;      // work | customer | invitation | auth | system
  createdAtIso: string;
}

export interface WorkspaceHomeData {
  isAdmin: boolean;
  /** Session organization. Exposed so the composed Home can load the Brain for the same org. */
  organizationId: string;
  header: WorkspaceHomeHeader;
  executiveSummary: string[];
  attention: AttentionItem[];
  attentionTotal: number;
  nextAction: NextActionView | null;
  workSummary: WorkSummary;
  activeFilter: WorkFilter;
  myWork: MyWorkItem[];        // already filtered to activeFilter
  notifications: { unreadCount: number; items: NotificationView[] };
  recentActivity: ActivityItem[];
  completedTodayCount: number;
  canCreateWork: boolean;
}

// ---------------------------------------------------------------------------
// Small pure helpers (no I/O).
// ---------------------------------------------------------------------------
function timeGreeting(d: Date): string {
  const h = d.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function longDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function relTime(from: Date, now: Date): string {
  const m = Math.round((now.getTime() - from.getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  return d + 'd ago';
}

/** Bare age ("6d", "3h") — the caller supplies the framing word. */
function age(from: Date, now: Date): string {
  const m = Math.round((now.getTime() - from.getTime()) / 60000);
  if (m < 60) return Math.max(m, 1) + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  return Math.round(h / 24) + 'd';
}

function jsonObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function resolveDisplayName(
  user: { name: string | null; email: string; metadata: unknown } | null,
  sessionName: string,
  sessionEmail: string,
): string {
  const profile = jsonObj(jsonObj(user?.metadata).profile);
  const preferred = str(profile.preferredName).trim();
  if (preferred) return preferred;
  const name = (user?.name ?? sessionName ?? '').trim();
  if (name) return name.split(' ')[0] || name;
  const email = user?.email ?? sessionEmail ?? '';
  return email.split('@')[0] || 'there';
}

function customerName(c: { firstName: string | null; lastName: string | null } | null): string {
  if (!c) return 'A customer';
  const n = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return n || 'A customer';
}

// Real, action-specific verb from a stage status. No fabricated states.
function stageVerb(status: string): string {
  if (status === 'in_progress') return 'Resume';
  if (status === 'ready') return 'Open';
  if (status === 'completed') return 'Review';
  return 'Open';
}

// Map an audit action to a color category (for the activity icon only). Purely
// presentational grouping of the real action string; no invented events.
function activityCategory(action: string): string {
  if (action.startsWith('work.')) return 'work';
  if (action.startsWith('customer.')) return 'customer';
  if (action.startsWith('invitation.') || action.startsWith('user.')) return 'invitation';
  if (action.startsWith('login') || action.startsWith('logout') || action.startsWith('auth')) return 'auth';
  return 'system';
}

const ACTIVITY_LABELS: Record<string, string> = {
  'organization.setup.completed': 'Owner setup completed',
  'organization.updated': 'Organization updated',
  'user.created': 'Team member added',
  'user.invited': 'Employee invited',
  'user.updated': 'Team member updated',
  'user.disabled': 'Team member disabled',
  'invitation.created': 'Invitation sent',
  'invitation.accepted': 'Invitation accepted',
  'customer.created': 'Customer created',
  'customer.updated': 'Customer updated',
  'work.created': 'Work created',
  'work.completed': 'Work completed',
  'work.assigned': 'Work assigned',
  'login.succeeded': 'Signed in',
};

export function activityLabel(action: string): string {
  if (ACTIVITY_LABELS[action]) return ACTIVITY_LABELS[action];
  const seg = action.split('.').pop() ?? action;
  return seg.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// The single loader. Guards + scopes, then loads every section in parallel.
// activeFilter selects which pre-computed work bucket the page renders.
// ---------------------------------------------------------------------------
export async function loadWorkspaceHome(activeFilter: WorkFilter): Promise<WorkspaceHomeData> {
  const session = await requireWorkspace('ADMIN');
  const userId = session.userId;
  const organizationId = session.organizationId;

  const work = repos.work;
  const now = new Date();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const stallCutoff = new Date(now.getTime() - STALL_HOURS * 3600 * 1000);

  // One round of parallel, organization-scoped reads.
  const [
    actingUser,
    organization,
    nextActionRaw,
    myWorkRaw,
    myCompletedStagesToday,
    myBlockedStages,
    notificationsRaw,
    pendingInvitations,
    unassignedWorkRaw,
    openConversationsCount,
    stalledConversationsRaw,
    stalledConversationsCount,
    newServiceRequests,
    newServiceRequestsCount,
    completedTodayCount,
    auditRows,
    canCreateWork,
  ] = await Promise.all([
    prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { name: true, email: true, metadata: true },
    }),
    repos.organizations.findById(organizationId),
    work.getMyNextAction(userId, organizationId),
    work.listMyWork(userId, organizationId),
    // Stages I completed today, with their instance title (bounded, org-scoped).
    prisma.workStage.findMany({
      where: {
        completedByUserId: userId,
        completedAt: { gte: startOfDay },
        workInstance: { organizationId },
      },
      select: {
        name: true, completedAt: true, workInstanceId: true,
        workInstance: { select: { title: true } },
      },
      orderBy: { completedAt: 'desc' },
      take: 20,
    }),
    // Active instances where I own a still-pending (blocked) stage, with title.
    prisma.workStage.findMany({
      where: {
        ownerUserId: userId,
        status: 'pending',
        workInstance: { organizationId, status: 'active' },
      },
      select: {
        name: true, createdAt: true, workInstanceId: true,
        workInstance: { select: { title: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    }),
    work.listNotifications(userId, organizationId),
    // Pending invitations, oldest first. expiresAt is real, so an invite that
    // has lapsed can say so instead of sitting silently.
    prisma.invitation.findMany({
      where: { organizationId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, createdAt: true, expiresAt: true },
      take: 10,
    }),
    work.listUnassignedWork(organizationId),
    prisma.conversation.count({ where: { organizationId, status: 'OPEN' } }),
    // Stalled = OPEN and silent since the cutoff. A conversation with no
    // messages at all falls back to its creation time — it has been silent
    // since it existed, which is the same fact.
    prisma.conversation.findMany({
      where: {
        organizationId,
        status: 'OPEN',
        OR: [
          { lastMessageAt: { lt: stallCutoff } },
          { lastMessageAt: null, createdAt: { lt: stallCutoff } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 10,
      select: {
        id: true, subject: true, createdAt: true, lastMessageAt: true,
        customer: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.conversation.count({
      where: {
        organizationId,
        status: 'OPEN',
        OR: [
          { lastMessageAt: { lt: stallCutoff } },
          { lastMessageAt: null, createdAt: { lt: stallCutoff } },
        ],
      },
    }),
    prisma.serviceRequest.findMany({
      where: { organizationId, status: 'NEW' },
      orderBy: { createdAt: 'asc' },
      take: 10,
      select: {
        id: true, summary: true, category: true, createdAt: true,
        customer: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.serviceRequest.count({ where: { organizationId, status: 'NEW' } }),
    prisma.workInstance.count({
      where: { organizationId, status: 'completed', completedAt: { gte: startOfDay } },
    }),
    repos.audit.list(organizationId, { take: 20 }),
    hasPermission('workflows', 'create'),
  ]);

  // ----- Header -----
  const header: WorkspaceHomeHeader = {
    greeting: timeGreeting(now),
    displayName: resolveDisplayName(actingUser, session.name, session.email),
    organizationName: organization?.name ?? 'Your organization',
    dateLabel: longDate(now),
    roleLabel: session.roleLabel || roleLabel(session.systemRole),
  };

  // ----- Work buckets (real rows powering the four clickable summary cards) -----
  // "Assigned to Me" = active instances where I own the current ready/in-progress
  // stage (exactly listMyWork, de-duped). "Ready Now" is the subset whose owned
  // stage is 'ready' (documented overlap: readyNow subset of assignedToMe).
  const ownsActionable = (inst: WorkInstance & { stages: WorkStage[] }) =>
    inst.stages.find(
      (s) => s.ownerUserId === userId && (s.status === 'ready' || s.status === 'in_progress'),
    ) ?? null;

  const assignedItems: MyWorkItem[] = [];
  const readyItems: MyWorkItem[] = [];
  // Waiting time drives ordering, so keep it alongside each row.
  const waitingSince = new Map<string, number>();
  for (const inst of myWorkRaw) {
    const stage = ownsActionable(inst);
    if (!stage) continue;
    const started = new Date(stage.startedAt ?? inst.createdAt);
    const item: MyWorkItem = {
      workInstanceId: inst.id,
      title: inst.title,
      stageName: stage.name,
      status: stage.status,
      verb: stageVerb(stage.status),
      assignedLabel: 'Waiting ' + age(started, now),
      href: '/app/admin/work/' + inst.id,
    };
    waitingSince.set(inst.id, started.getTime());
    assignedItems.push(item);
    if (stage.status === 'ready') readyItems.push(item);
  }
  // Ready before in-progress, then longest-waiting first. Age is the only
  // ranking signal the schema supports — there are no priorities or due dates.
  const byReadyThenAge = (a: MyWorkItem, b: MyWorkItem) => {
    const rank = (s: string) => (s === 'ready' ? 0 : 1);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return (waitingSince.get(a.workInstanceId) ?? 0) - (waitingSince.get(b.workInstanceId) ?? 0);
  };
  assignedItems.sort(byReadyThenAge);
  readyItems.sort(byReadyThenAge);

  const blockedItems: MyWorkItem[] = [];
  const blockedInstanceIds = new Set<string>();
  for (const s of myBlockedStages) {
    if (blockedInstanceIds.has(s.workInstanceId)) continue;
    blockedInstanceIds.add(s.workInstanceId);
    blockedItems.push({
      workInstanceId: s.workInstanceId,
      title: s.workInstance.title,
      stageName: s.name,
      status: 'pending',
      verb: 'Open',
      assignedLabel: 'Waiting on an earlier step',
      href: '/app/admin/work/' + s.workInstanceId,
    });
  }

  const completedItems: MyWorkItem[] = [];
  const completedInstanceIds = new Set<string>();
  for (const s of myCompletedStagesToday) {
    if (completedInstanceIds.has(s.workInstanceId)) continue;
    completedInstanceIds.add(s.workInstanceId);
    completedItems.push({
      workInstanceId: s.workInstanceId,
      title: s.workInstance.title,
      stageName: s.name,
      status: 'completed',
      verb: 'Review',
      assignedLabel: s.completedAt ? 'Completed ' + relTime(new Date(s.completedAt), now) : 'Completed today',
      href: '/app/admin/work/' + s.workInstanceId,
    });
  }

  const workSummary: WorkSummary = {
    assignedToMe: assignedItems.length,
    readyNow: readyItems.length,
    waitingBlocked: blockedInstanceIds.size,
    completedToday: completedInstanceIds.size,
  };

  const bucket: Record<WorkFilter, MyWorkItem[]> = {
    assigned: assignedItems,
    ready: readyItems,
    blocked: blockedItems,
    completed: completedItems,
  };
  const myWork = bucket[activeFilter].slice(0, 5);

  // ----- Next Action (one only, with a real verb) -----
  const nextAction: NextActionView | null = nextActionRaw
    ? {
        workInstanceId: nextActionRaw.instance.id,
        title: nextActionRaw.instance.title,
        stageName: nextActionRaw.stage.name,
        verb: stageVerb(nextActionRaw.stage.status),
        href: '/app/admin/work/' + nextActionRaw.instance.id,
      }
    : null;

  // ----- Notifications (three newest UNREAD) -----
  const unread = notificationsRaw.filter((n: WorkNotification) => !n.readAt);
  const notificationItems: NotificationView[] = unread.slice(0, 3).map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    kind: n.type,
    createdAtIso: n.createdAt.toISOString(),
    href: n.workInstanceId ? '/app/admin/work/' + n.workInstanceId : null,
  }));

  // ----- Needs attention: concrete decisions, ranked oldest-waiting first -----
  // Each entry pairs a real row with the rule that surfaced it. Nothing here is
  // scored, inferred or ranked by opinion.
  const attentionRaw: { item: AttentionItem; since: number }[] = [];

  for (const s of unassignedWorkRaw) {
    const since = new Date(s.startedAt ?? s.workInstance.createdAt);
    attentionRaw.push({
      since: since.getTime(),
      item: {
        key: 'work:' + s.id,
        kind: 'work',
        kindLabel: 'Work',
        title: s.workInstance.title,
        reason: s.name + ' · ready ' + age(since, now) + ', no owner',
        href: '/app/admin/work/' + s.workInstanceId,
        cta: 'Assign',
      },
    });
  }

  for (const c of stalledConversationsRaw) {
    const last = new Date(c.lastMessageAt ?? c.createdAt);
    const who = customerName(c.customer);
    attentionRaw.push({
      since: last.getTime(),
      item: {
        key: 'conv:' + c.id,
        kind: 'conversation',
        kindLabel: 'Conversation',
        title: c.subject || who,
        reason: c.lastMessageAt
          ? who + ' · no reply in ' + age(last, now)
          : who + ' · opened ' + age(last, now) + ' ago, no messages',
        href: '/crm/conversations',
        cta: 'Reply',
      },
    });
  }

  for (const r of newServiceRequests) {
    const since = new Date(r.createdAt);
    const who = customerName(r.customer);
    attentionRaw.push({
      since: since.getTime(),
      item: {
        key: 'req:' + r.id,
        kind: 'request',
        kindLabel: 'Service request',
        title: r.summary || r.category || 'Service request',
        reason: who + ' · unqualified for ' + age(since, now),
        href: '/crm/customers',
        cta: 'Qualify',
      },
    });
  }

  for (const inv of pendingInvitations) {
    const since = new Date(inv.createdAt);
    const expired = new Date(inv.expiresAt).getTime() < now.getTime();
    attentionRaw.push({
      since: since.getTime(),
      item: {
        key: 'inv:' + inv.id,
        kind: 'invitation',
        kindLabel: 'Invitation',
        title: inv.email,
        reason: expired
          ? 'Invite expired · sent ' + age(since, now) + ' ago, never accepted'
          : 'Invited ' + age(since, now) + ' ago, not accepted yet',
        href: '/crm/users',
        cta: expired ? 'Re-invite' : 'Review',
      },
    });
  }

  attentionRaw.sort((a, b) => a.since - b.since);
  const attention = attentionRaw.slice(0, 6).map((a) => a.item);
  const attentionTotal =
    unassignedWorkRaw.length +
    stalledConversationsCount +
    newServiceRequestsCount +
    pendingInvitations.length;

  // ----- Executive summary (composed ONLY from counts already read) -----
  const summary: string[] = [];
  if (workSummary.readyNow > 0) {
    summary.push(
      workSummary.readyNow +
        (workSummary.readyNow === 1 ? ' work item is ready for you.' : ' work items are ready for you.'),
    );
  }
  if (unassignedWorkRaw.length > 0) {
    summary.push(
      unassignedWorkRaw.length +
        (unassignedWorkRaw.length === 1 ? ' work item needs an owner.' : ' work items need an owner.'),
    );
  }
  if (stalledConversationsCount > 0) {
    summary.push(
      stalledConversationsCount +
        (stalledConversationsCount === 1 ? ' conversation has gone quiet.' : ' conversations have gone quiet.'),
    );
  }
  if (newServiceRequestsCount > 0) {
    summary.push(
      newServiceRequestsCount +
        (newServiceRequestsCount === 1 ? ' service request is unqualified.' : ' service requests are unqualified.'),
    );
  }
  if (summary.length === 0) {
    summary.push(
      openConversationsCount > 0
        ? 'Nothing is waiting on you. ' + openConversationsCount + ' conversation' +
          (openConversationsCount === 1 ? ' is' : 's are') + ' open and moving.'
        : 'Nothing is waiting on you.',
    );
  }

  // ----- Recent BUSINESS activity -----
  // Sign-ins and other auth noise are excluded: the dashboard shows what
  // happened in the BUSINESS, not who logged in when.
  const recentActivity: ActivityItem[] = auditRows
    .map((r: AuditView) => ({
      id: r.id,
      label: activityLabel(r.action),
      actorName: r.actorName,
      category: activityCategory(r.action),
      createdAtIso: r.createdAt,
    }))
    .filter((a) => a.category !== 'auth')
    .slice(0, 6);

  return {
    isAdmin: true,
    organizationId,
    header,
    executiveSummary: summary,
    attention,
    attentionTotal,
    nextAction,
    workSummary,
    activeFilter,
    myWork,
    notifications: { unreadCount: unread.length, items: notificationItems },
    recentActivity,
    completedTodayCount,
    canCreateWork,
  };
}
