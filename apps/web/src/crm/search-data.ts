import type { Repositories } from '@emgloop/database';

// CRM Governed Search — the reads behind /crm/search.
//
// Authorization is resolved by the page from the signed session and passed in;
// this function only honours it. A source the user may not see is never queried.
// Every read is scoped to the organization it is given, bounded, and typed
// honestly: a Customer is "Person / Intake Record", never an Opportunity, and the
// only organization that can appear is the session's own workspace.

export type ResultKind = 'person' | 'conversation' | 'organization';

export interface SearchResult {
  id: string;
  kind: ResultKind;
  title: string;
  subtitle: string;
  href: string;
  meta?: string;
}

export type SearchRepos = Pick<Repositories, 'crm' | 'conversationsInbox' | 'organizations'>;

export interface SearchAccess {
  canViewConversations: boolean;
  canViewOrganizations: boolean;
}

export const SEARCH_LIMITS = { people: 20, conversations: 15, queryLength: 200 } as const;

export function kindLabel(kind: ResultKind): string {
  switch (kind) {
    case 'person': return 'Person / Intake Record';
    case 'conversation': return 'Conversation';
    case 'organization': return 'Workspace Organization';
  }
}

/** Trimmed and length-capped. The text is only ever a bound query parameter. */
export function normalizeQuery(raw: string | undefined): string {
  return (raw ?? '').trim().slice(0, SEARCH_LIMITS.queryLength);
}

export async function runSearch(
  repos: SearchRepos,
  organizationId: string,
  query: string,
  access: SearchAccess,
): Promise<SearchResult[]> {
  const q = normalizeQuery(query);
  if (!q) return [];

  const [people, conversations, organization] = await Promise.all([
    repos.crm.listCustomers(organizationId, { search: q, pageSize: SEARCH_LIMITS.people, page: 1 }),
    access.canViewConversations
      ? repos.conversationsInbox.listConversations(organizationId, { search: q })
      : Promise.resolve(null),
    access.canViewOrganizations ? repos.organizations.findById(organizationId) : Promise.resolve(null),
  ]);

  const results: SearchResult[] = [];

  if (organization && organization.name.toLowerCase().includes(q.toLowerCase())) {
    results.push({
      id: organization.id,
      kind: 'organization',
      title: organization.name,
      subtitle: [organization.industry, organization.timezone, organization.status].filter(Boolean).join(' · '),
      href: `/crm/organizations/${organization.id}`,
      meta: 'Workspace',
    });
  }

  for (const c of people.rows.slice(0, SEARCH_LIMITS.people)) {
    results.push({
      id: c.id,
      kind: 'person',
      title: c.name || 'Unnamed',
      subtitle: [c.company, c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details',
      href: `/crm/customers/${c.id}`,
      meta: c.status,
    });
  }

  for (const c of (conversations?.rows ?? []).slice(0, SEARCH_LIMITS.conversations)) {
    results.push({
      id: c.id,
      kind: 'conversation',
      title: c.subject || 'No subject',
      subtitle: [c.customerName, c.channel, c.assigneeName].filter(Boolean).join(' · '),
      href: `/crm/conversations/${c.id}`,
      meta: c.status,
    });
  }

  return results;
}
