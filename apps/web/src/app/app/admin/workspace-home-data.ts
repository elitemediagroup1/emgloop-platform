import 'server-only';

// Sprint 25 — Executive Operating System data loader (/app/admin).
//
// Evolves the Sprint 24 canonical Workspace Home from a REPORTING page into an
// executive command center. Same non-negotiables carry over: identity is ALWAYS
// derived from the authenticated session (never URL/client input); every read is
// scoped to session.organizationId; the existing repository layer is reused; no
// new engine, no demo store, no mock providers, no servicesinmycity resolver,
// NO Prisma schema changes, no fabricated data.
//
// Sprint 25 additions are TRUTH-ONLY and reuse existing queries:
//   - executiveSummary: 1-3 sentences composed purely from counts already read.
//   - work buckets (assigned / ready / blocked / completed today) as real rows,
//     so the summary cards can filter the My Work list without a new concept.
//   - actionable intake items (oldest pending invitation, an unassigned work
//     item, the newest open conversation) instead of bare numbers.
//   - CRM newest customer + newest conversation (real createdAt ordering).
//   - color category for each activity row (derived from the audit action).
// Anything unsupported by the schema stays omitted (no due dates, no per-user
// CRM ownership, no per-org Loop events, no access-request count).

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
  assignedLabel: string; // human "assigned" date from the stage/instance
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

// One actionable intake item (a real entity that needs a decision), not a count.
export interface IntakeItem {
  key: string;
  label: string;         // section label, e.g. "Pending Invitations"
  count: number;         // real total for the framing line
  primaryTitle: string;  // the concrete item, e.g. an email or work title
  primaryDetail: string; // supporting line, e.g. "Invited 2d ago"
  href: string;
  cta: string;           // Review | Assign | Open
  empty: boolean;        // true => show the truthful empty line
  emptyLabel: string;
}

export interface CrmHighlight {
  key: string;
  label: string;
  title: string;
  detail: string;
  href: string;
  cta: string;
  present: boolean;
}

export interface ActivityItem {
  id: string;
  label: string;
  actorName: string;
  category: string;      // work | customer | invitation | auth | system
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
  executiveSummary: string[];
  nextAction: NextActionView | null;
  workSummary: WorkSummary;
  activeFilter: WorkFilter;
  myWork: MyWorkItem[];        // already filtered to activeFilter
  crmTotals: { totalCustomers: number; openConversations: number };
  notifications: { unreadCount: number; items: NotificationView[] };
  intake: IntakeItem[];
  crm: CrmHighlight[];
  recentActivity: ActivityItem[];
  quickActions: QuickAction[];
  gettingStarted: { show: boolean; items: ChecklistItem[] };
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

function relWait(from: Date, now: Date): string {
  const m = Math.round((now.getTime() - from.getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return 'waiting ' + m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return 'waiting ' + h + 'h';
  const d = Math.round(h / 24);
  return 'waiting ' + d + 'd';
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

  // One round of parallel, organization-scoped reads. Every query below already
  // existed in Sprint 24 or in the shared repositories; nothing new conceptually.
  const [
    actingUser,
    organization,
    nextActionRaw,
    myWorkRaw,
    myCompletedStagesToday,
    myBlockedStages,
    notificationsRaw,
    pendingInvitationsCount,
    oldestPendingInvite,
    unassignedWorkRaw,
    openConversationsCount,
    unassignedConversationsCount,
    totalCustomers,
    serviceRequestsNew,
    newestCustomer,
    newestOpenConversation,
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
    prisma.invitation.count({ where: { organizationId, status: 'PENDING' } }),
    prisma.invitation.findFirst({
      where: { organizationId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { email: true, createdAt: true },
    }),
    work.listUnassignedWork(organizationId),
    prisma.conversation.count({ where: { organizationId, status: 'OPEN' } }),
    prisma.conversation.count({ where: { organizationId, status: 'OPEN', assigneeId: null } }),
    prisma.customer.count({ where: { organizationId } }),
    prisma.serviceRequest.count({ where: { organizationId, status: 'NEW' } }),
    prisma.customer.findFirst({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, firstName: true, lastName: true, createdAt: true },
    }),
    prisma.conversation.findFirst({
      where: { organizationId, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, subject: true, createdAt: true, lastMessageAt: true,
        customer: { select: { firstName: true, lastName: true } },
      },
    }),
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
  for (const inst of myWorkRaw) {
    const stage = ownsActionable(inst);
    if (!stage) continue;
    const started = stage.startedAt ?? inst.createdAt;
    const item: MyWorkItem = {
      workInstanceId: inst.id,
      title: inst.title,
      stageName: stage.name,
      status: stage.status,
      verb: stageVerb(stage.status),
      assignedLabel: 'Assigned ' + relTime(new Date(started), now),
      href: '/app/admin/work/' + inst.id,
    };
    assignedItems.push(item);
    if (stage.status === 'ready') readyItems.push(item);
  }
  assignedItems.sort((a, b) => {
    const rank = (s: string) => (s === 'ready' ? 0 : 1);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return a.title.localeCompare(b.title);
  });

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

  // ----- Notifications (five newest UNREAD) -----
  const unread = notificationsRaw.filter((n: WorkNotification) => !n.readAt);
  const notificationItems: NotificationView[] = unread.slice(0, 5).map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    kind: n.type,
    createdAtIso: n.createdAt.toISOString(),
    href: n.workInstanceId ? '/app/admin/work/' + n.workInstanceId : null,
  }));

  // ----- Executive summary (composed ONLY from counts already read) -----
  const summary: string[] = [];
  const urgent = workSummary.readyNow;
  if (urgent > 0) {
    summary.push('You have ' + urgent + (urgent === 1 ? ' work item ready for you.' : ' work items ready for you.'));
  } else if (workSummary.assignedToMe > 0) {
    summary.push('No work is waiting on you right now.');
  } else {
    summary.push('You have no assigned work today.');
  }
  if (openConversationsCount > 0) {
    summary.push(openConversationsCount + (openConversationsCount === 1 ? ' customer conversation needs attention.' : ' customer conversations need attention.'));
  }
  if (pendingInvitationsCount > 0) {
    summary.push(pendingInvitationsCount + (pendingInvitationsCount === 1 ? ' employee invitation is awaiting acceptance.' : ' employee invitations are awaiting acceptance.'));
  } else {
    summary.push('No employee requests are waiting.');
  }
  if (unassignedWorkRaw.length > 0) {
    summary.push(unassignedWorkRaw.length + (unassignedWorkRaw.length === 1 ? ' work item needs an owner.' : ' work items need an owner.'));
  }

  // ----- Business Intake (actionable items, admin-only, org-scoped) -----
  const inviteItem: IntakeItem = {
    key: 'invites',
    label: 'Pending Invitations',
    count: pendingInvitationsCount,
    primaryTitle: oldestPendingInvite?.email ?? '',
    primaryDetail: oldestPendingInvite ? 'Invited ' + relTime(new Date(oldestPendingInvite.createdAt), now) : '',
    href: '/crm/users',
    cta: 'Review',
    empty: pendingInvitationsCount === 0,
    emptyLabel: 'No pending invitations.',
  };
  const firstUnassigned = unassignedWorkRaw[0];
  const unassignedItem: IntakeItem = {
    key: 'unassigned-work',
    label: 'Unassigned Work',
    count: unassignedWorkRaw.length,
    primaryTitle: firstUnassigned ? firstUnassigned.workInstance.title : '',
    primaryDetail: firstUnassigned ? 'Needs an owner: ' + firstUnassigned.name : '',
    href: '/app/admin/work',
    cta: 'Assign',
    empty: unassignedWorkRaw.length === 0,
    emptyLabel: 'All work is assigned.',
  };
  const convCustomer = newestOpenConversation ? customerName(newestOpenConversation.customer) : '';
  const convWaitFrom = newestOpenConversation
    ? new Date(newestOpenConversation.lastMessageAt ?? newestOpenConversation.createdAt)
    : null;
  const conversationItem: IntakeItem = {
    key: 'open-conversations',
    label: 'Open Conversations',
    count: openConversationsCount,
    primaryTitle: newestOpenConversation ? (newestOpenConversation.subject || convCustomer) : '',
    primaryDetail: convWaitFrom ? convCustomer + ' \u00b7 ' + relWait(convWaitFrom, now) : '',
    href: '/crm/conversations',
    cta: 'Open',
    empty: openConversationsCount === 0,
    emptyLabel: 'No open conversations.',
  };
  const intake: IntakeItem[] = [inviteItem, unassignedItem, conversationItem];

  // ----- CRM Overview (org-scoped; newest entities, NO per-user ownership) -----
  const crm: CrmHighlight[] = [
    {
      key: 'customers',
      label: 'Total Customers',
      title: String(totalCustomers),
      detail: totalCustomers === 1 ? '1 customer in your CRM' : totalCustomers + ' customers in your CRM',
      href: '/crm/customers',
      cta: 'View all',
      present: true,
    },
    {
      key: 'open-convos',
      label: 'Open Conversations',
      title: String(openConversationsCount),
      detail: unassignedConversationsCount > 0
        ? unassignedConversationsCount + ' unassigned'
        : (openConversationsCount === 0 ? 'None open' : 'All assigned'),
      href: '/crm/conversations',
      cta: 'View all',
      present: true,
    },
    {
      key: 'newest-customer',
      label: 'Newest Customer',
      title: newestCustomer ? customerName(newestCustomer) : '',
      detail: newestCustomer ? 'Added ' + relTime(new Date(newestCustomer.createdAt), now) : '',
      href: newestCustomer ? '/crm/customers/' + newestCustomer.id : '/crm/customers',
      cta: 'Open',
      present: Boolean(newestCustomer),
    },
    {
      key: 'newest-conversation',
      label: 'Newest Conversation',
      title: newestOpenConversation ? (newestOpenConversation.subject || convCustomer) : '',
      detail: convWaitFrom ? convCustomer + ' \u00b7 ' + relWait(convWaitFrom, now) : '',
      href: newestOpenConversation ? '/crm/conversations' : '/crm/conversations',
      cta: 'Reply',
      present: Boolean(newestOpenConversation),
    },
  ];
  if (serviceRequestsNew > 0) {
    crm.push({
      key: 'service-requests',
      label: 'New Service Requests',
      title: String(serviceRequestsNew),
      detail: serviceRequestsNew === 1 ? '1 request to qualify' : serviceRequestsNew + ' requests to qualify',
      href: '/crm/customers',
      cta: 'Review',
      present: true,
    });
  }

  // ----- Recent Activity (org-scoped audit log, max 8, color-categorized) -----
  const recentActivity: ActivityItem[] = auditRows.slice(0, 8).map((r: AuditView) => ({
    id: r.id,
    label: activityLabel(r.action),
    actorName: r.actorName,
    category: activityCategory(r.action),
    createdAtIso: r.createdAt,
  }));

  // ----- Quick Actions (Sprint 25 order; only real routes + permitted actions) -----
  const quickActions: QuickAction[] = [];
  if (canCreateWork) quickActions.push({ key: 'create-work', label: 'Create Work', href: '/app/admin/work/new', icon: 'flow' });
  if (canCreateCustomers) quickActions.push({ key: 'add-customer', label: 'Add Customer', href: '/crm/customers', icon: 'users' });
  if (canInviteUsers) quickActions.push({ key: 'invite', label: 'Invite Employee', href: '/crm/users', icon: 'team' });
  quickActions.push({ key: 'my-work', label: 'View My Work', href: '/app/admin/work', icon: 'columns' });
  if (canManageSettings) quickActions.push({ key: 'settings', label: 'Organization Settings', href: '/crm/settings', icon: 'cog' });
  if (canViewAudit) quickActions.push({ key: 'audit', label: 'View Audit Log', href: '/crm/audit', icon: 'activity' });

  // ----- Getting Started (real DB state; hidden once every item is complete) -----
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
    executiveSummary: summary,
    nextAction,
    workSummary,
    activeFilter,
    myWork,
    crmTotals: { totalCustomers, openConversations: openConversationsCount },
    notifications: { unreadCount: unread.length, items: notificationItems },
    intake,
    crm,
    recentActivity,
    quickActions,
    gettingStarted: { show: !allDone, items: checklist },
  };
}
