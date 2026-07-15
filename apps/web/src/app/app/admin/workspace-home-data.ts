import 'server-only';

// Sprint 24 — Canonical Workspace Home data loader.
//
// One typed, server-side loader for the ADMIN Workspace Home at /app/admin.
// Identity is ALWAYS derived from the authenticated session (never from URL or
// client input); every read is scoped to session.organizationId. It reuses the
// existing repository layer (WorkRepository, Crm/Conversations, Audit, Org,
// Iam) shipped in prior sprints — no new engine, no Brain, no demo store, no
// mock providers, no servicesinmycity-demo resolver, no schema changes.
//
// Truthfulness rules (Sprint 24): only fields that exist in the current schema
// are surfaced. Work has no due-date column, so there is no "Due Today".
// Customer assignment is free-text (no userId FK), so there is no per-user CRM
// ownership. LoopEvent has no organizationId, so no per-org event count. Access
// requests are email-only (no model). Missing data becomes an honest empty
// state, never fabricated content.

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

// ---------------------------------------------------------------------------
// Typed shape returned to the page. One object, one round of parallel reads.
// ---------------------------------------------------------------------------
export interface WorkspaceHomeHeader {
  greeting: string;          // "Good morning" | "Good afternoon" | "Good evening"
  displayName: string;       // preferredName -> name -> email prefix -> "there"
  organizationName: string;
  dateLabel: string;         // e.g. "Tuesday, July 15"
  roleLabel: string;         // real system role label
}

export interface NextActionView {
  workInstanceId: string;
  stageId: string;
  title: string;
  stageName: string;
  href: string;
}

export interface WorkSummary {
  assignedToMe: number;      // instances where I own the current ready/in-progress stage
  readyNow: number;          // of those, stages with status 'ready'
  waitingBlocked: number;    // instances I own a later stage of, but not the current one
  completedToday: number;    // instances where I completed a stage today
}

export interface MyWorkItem {
  workInstanceId: string;
  title: string;
  stageName: string;
  status: string;            // ready | in_progress
  href: string;
}

export interface NotificationView {
  id: string;
  title: string;
  body: string;
  createdAtIso: string;
  workInstanceId: string | null;
  href: string | null;
}

export interface IntakeCard {
  key: string;
  label: string;
  count: number;
  href: string;
}

export interface CrmCard {
  key: string;
  label: string;
  count: number;
  href: string;
}

export interface ActivityItem {
  id: string;
  label: string;             // human-readable action label
  actorName: string;
  entity: string | null;
  createdAtIso: string;
}

export interface QuickAction {
  key: string;
  label: string;
  href: string;
  icon: string;
}

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
}

export interface WorkspaceHomeData {
  isAdmin: boolean;
  header: WorkspaceHomeHeader;
  nextAction: NextActionView | null;
  workSummary: WorkSummary;
  myWork: MyWorkItem[];
  notifications: {
    unreadCount: number;
    items: NotificationView[];
  };
  intake: IntakeCard[];
  crm: CrmCard[];
  recentActivity: ActivityItem[];
  quickActions: QuickAction[];
  gettingStarted: {
    show: boolean;
    items: ChecklistItem[];
  };
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
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function jsonObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Resolve the greeting name from the acting user's record. Order:
// preferredName -> name -> email prefix -> "there". The setup wizard persists
// preferredName to User.metadata.profile.preferredName.
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
  const prefix = email.split('@')[0];
  return prefix || 'there';
}

// Map a technical audit action (e.g. "organization.setup.completed") to a safe
// human-readable label. Unknown actions degrade to a Title-Cased last segment.
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
  return seg
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// The single loader. Guards + scopes, then loads every section in parallel.
// ---------------------------------------------------------------------------
export async function loadWorkspaceHome(): Promise<WorkspaceHomeData> {
  // Identity + workspace guard. requireWorkspace('ADMIN') fail-closes: a
  // non-admin session is redirected to its own home before this runs.
  const session = await requireWorkspace('ADMIN');
  const userId = session.userId;
  const organizationId = session.organizationId;

  const work = repos.work;
  const now = new Date();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // Parallel, organization-scoped reads. Counts use DB count() where possible;
  // list reads are bounded by the repository (my work / notifications) or by
  // an explicit take (activity).
  const [
    actingUser,
    organization,
    nextActionRaw,
    myWorkRaw,
    completedTodayCount,
    waitingBlockedCount,
    notificationsRaw,
    pendingInvitations,
    unassignedWorkRaw,
    openConversations,
    unassignedConversations,
    totalCustomers,
    serviceRequestsNew,
    auditRows,
    canInviteUsers,
    canCreateCustomers,
    canManageSettings,
    canViewAudit,
    canCreateWork,
  ] = await Promise.all([
    prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { name: true, email: true, metadata: true },
    }),
    repos.organizations.findById(organizationId),
    work.getMyNextAction(userId, organizationId),
    work.listMyWork(userId, organizationId),
    // "Completed today" = distinct instances where I completed a stage today.
    prisma.workStage
      .findMany({
        where: {
          completedByUserId: userId,
          completedAt: { gte: startOfDay },
          workInstance: { organizationId },
        },
        select: { workInstanceId: true },
      })
      .then((rows) => new Set(rows.map((r) => r.workInstanceId)).size),
    // "Waiting / Blocked" = active instances where I own SOME stage but not the
    // current ready/in-progress one (I cannot act yet). Counted from my stages.
    prisma.workStage
      .findMany({
        where: {
          ownerUserId: userId,
          status: { in: ['pending'] },
          workInstance: { organizationId, status: 'active' },
        },
        select: { workInstanceId: true },
      })
      .then((rows) => new Set(rows.map((r) => r.workInstanceId)).size),
    work.listNotifications(userId, organizationId),
    prisma.invitation.count({ where: { organizationId, status: 'PENDING' } }),
    work.listUnassignedWork(organizationId),
    prisma.conversation.count({ where: { organizationId, status: 'OPEN' } }),
    prisma.conversation.count({ where: { organizationId, status: 'OPEN', assigneeId: null } }),
    prisma.customer.count({ where: { organizationId } }),
    prisma.serviceRequest.count({ where: { organizationId, status: 'NEW' } }),
    repos.audit.list(organizationId, { take: 8 }),
    hasPermission('users', 'create'),
    hasPermission('customers', 'create'),
    hasPermission('settings', 'view'),
    hasPermission('audit', 'view'),
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

  // ----- Next Action (one only) -----
  const nextAction: NextActionView | null = nextActionRaw
    ? {
        workInstanceId: nextActionRaw.instance.id,
        stageId: nextActionRaw.stage.id,
        title: nextActionRaw.instance.title,
        stageName: nextActionRaw.stage.name,
        href: '/app/admin/work/' + nextActionRaw.instance.id,
      }
    : null;

  // ----- My Work Summary -----
  // assignedToMe: distinct active instances where I own the current
  //   ready/in-progress stage (exactly what listMyWork returns, de-duped).
  // readyNow: of those, the ones whose current owned stage is 'ready'.
  // These two intentionally OVERLAP (readyNow is a subset of assignedToMe);
  // documented here so the numbers read honestly.
  const ownsActionable = (inst: WorkInstance & { stages: WorkStage[] }) =>
    inst.stages.find(
      (s) => s.ownerUserId === userId && (s.status === 'ready' || s.status === 'in_progress'),
    ) ?? null;

  let readyNow = 0;
  const myWork: MyWorkItem[] = [];
  for (const inst of myWorkRaw) {
    const stage = ownsActionable(inst);
    if (!stage) continue;
    if (stage.status === 'ready') readyNow += 1;
    if (myWork.length < 5) {
      myWork.push({
        workInstanceId: inst.id,
        title: inst.title,
        stageName: stage.name,
        status: stage.status,
        href: '/app/admin/work/' + inst.id,
      });
    }
  }
  // Ordering: ready stages first, then in-progress; then by title for stability.
  myWork.sort((a, b) => {
    const rank = (s: string) => (s === 'ready' ? 0 : 1);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return a.title.localeCompare(b.title);
  });

  const workSummary: WorkSummary = {
    assignedToMe: myWorkRaw.length,
    readyNow,
    waitingBlocked: waitingBlockedCount,
    completedToday: completedTodayCount,
  };

  // ----- Notifications (five newest UNREAD) -----
  const unread = notificationsRaw.filter((n: WorkNotification) => !n.readAt);
  const notificationItems: NotificationView[] = unread.slice(0, 5).map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    createdAtIso: n.createdAt.toISOString(),
    workInstanceId: n.workInstanceId ?? null,
    href: n.workInstanceId ? '/app/admin/work/' + n.workInstanceId : null,
  }));

  // ----- Business Intake (admin-only, org-scoped, real data only) -----
  // NOTE (truthful omissions):
  //  - No "Pending Access Requests": access requests are email-only today
  //    (no AccessRequest model). Surfaced as a note in the UI, not a count.
  //  - No "Unprocessed Loop Events": LoopEvent has no organizationId, so a
  //    per-organization count cannot be produced without cross-org leakage.
  const intake: IntakeCard[] = [
    { key: 'invites', label: 'Pending Invitations', count: pendingInvitations, href: '/crm/users' },
    { key: 'unassigned-work', label: 'Unassigned Work', count: unassignedWorkRaw.length, href: '/app/admin/work' },
    { key: 'open-conversations', label: 'Open Conversations', count: openConversations, href: '/crm/conversations' },
  ];

  // ----- CRM Overview (org-scoped counts only; NO per-user ownership) -----
  // Customer assignment is free-text (no userId FK), so no "assigned to me".
  const crm: CrmCard[] = [
    { key: 'customers', label: 'Total Customers', count: totalCustomers, href: '/crm/customers' },
    { key: 'open-convos', label: 'Open Conversations', count: openConversations, href: '/crm/conversations' },
    { key: 'unassigned-convos', label: 'Unassigned Conversations', count: unassignedConversations, href: '/crm/conversations' },
    { key: 'service-requests', label: 'New Service Requests', count: serviceRequestsNew, href: '/crm/customers' },
  ];

  // ----- Recent Activity (org-scoped audit log, max 8) -----
  const recentActivity: ActivityItem[] = auditRows.slice(0, 8).map((r: AuditView) => ({
    id: r.id,
    label: activityLabel(r.action),
    actorName: r.actorName,
    entity: r.entityType,
    createdAtIso: r.createdAt,
  }));

  // ----- Quick Actions (only real routes + permitted actions) -----
  const quickActions: QuickAction[] = [];
  if (canCreateWork) quickActions.push({ key: 'create-work', label: 'Create Work', href: '/app/admin/work/new', icon: 'flow' });
  quickActions.push({ key: 'my-work', label: 'View My Work', href: '/app/admin/work', icon: 'columns' });
  if (canInviteUsers) quickActions.push({ key: 'invite', label: 'Invite Employee', href: '/crm/users', icon: 'team' });
  if (canCreateCustomers) quickActions.push({ key: 'add-customer', label: 'Add Customer', href: '/crm/customers', icon: 'users' });
  if (canManageSettings) quickActions.push({ key: 'settings', label: 'Organization Settings', href: '/crm/settings', icon: 'cog' });
  if (canViewAudit) quickActions.push({ key: 'audit', label: 'View Audit Log', href: '/crm/audit', icon: 'activity' });

  // ----- Getting Started (real database state only) -----
  // Hidden entirely once every displayed item is complete. Each item is a real
  // existence check scoped to this organization. "First Loop event" is OMITTED
  // because LoopEvent cannot be safely tied to an organization in the current
  // schema (no organizationId) — surfacing it would risk a cross-org signal.
  const orgSettings = jsonObj(organization?.settings);
  const onboarding = jsonObj(orgSettings.onboarding);
  const setupComplete = Boolean(str(onboarding.completedAt));

  const [firstInvite, firstCustomer, firstBlueprint, firstWork] = await Promise.all([
    prisma.invitation.count({ where: { organizationId } }).then((n) => n > 0),
    prisma.customer.count({ where: { organizationId } }).then((n) => n > 0),
    prisma.blueprint.count({ where: { organizationId } }).then((n) => n > 0),
    prisma.workInstance.count({ where: { organizationId } }).then((n) => n > 0),
  ]);

  const checklist: ChecklistItem[] = [
    { key: 'setup', label: 'Owner setup complete', done: setupComplete },
    { key: 'invite', label: 'First employee invitation created', done: firstInvite },
    { key: 'customer', label: 'First customer created', done: firstCustomer },
    { key: 'blueprint', label: 'First blueprint created', done: firstBlueprint },
    { key: 'work', label: 'First work item created', done: firstWork },
  ];
  const allDone = checklist.every((c) => c.done);

  return {
    isAdmin: true,
    header,
    nextAction,
    workSummary,
    myWork,
    notifications: {
      unreadCount: unread.length,
      items: notificationItems,
    },
    intake,
    crm,
    recentActivity,
    quickActions,
    gettingStarted: {
      show: !allDone,
      items: checklist,
    },
  };
}
