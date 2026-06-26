// @emgloop/brain — Customer Intelligence Graph.
//
// Sprint 12: architecture for a provider-agnostic, tenant-safe graph describing
// relationships between every entity the platform understands. No graph database
// is introduced; this defines the node/edge contracts and the query surface so a
// concrete store (Postgres adjacency, or a future graph DB) can implement it
// without changing callers.

import type { Confidence, Metadata } from './types';

/** Node types in the intelligence graph. */
export type GraphNodeType =
  | 'customer'
  | 'organization'
  | 'interaction'
  | 'signal'
  | 'booking'
  | 'message'
  | 'call'
  | 'revenue_event'
  | 'campaign'
  | 'creator'
  | 'business'
  | 'ai_employee'
  | 'knowledge';

/** Edge (relationship) types between nodes. */
export type GraphEdgeType =
  | 'belongs_to'
  | 'participated_in'
  | 'generated'
  | 'derived_from'
  | 'assigned_to'
  | 'related_to'
  | 'converted_to'
  | 'attributed_to'
  | 'references';

/** A graph node. Always scoped to one organization (tenant-safe). */
export interface GraphNode {
  id: string;
  type: GraphNodeType;
  organizationId: string;
  label?: string;
  metadata?: Metadata;
}

/** A directed, typed edge between two nodes in the same organization. */
export interface GraphEdge {
  id?: string;
  type: GraphEdgeType;
  organizationId: string;
  fromId: string;
  toId: string;
  confidence?: Confidence;
  observedAt?: Date;
  metadata?: Metadata;
}

/** A query against the graph, always tenant-scoped. */
export interface GraphQuery {
  organizationId: string;
  startNodeId: string;
  /** Edge types to traverse; empty = any. */
  edgeTypes?: GraphEdgeType[];
  /** Node types to return; empty = any. */
  nodeTypes?: GraphNodeType[];
  /** Max traversal depth. */
  depth?: number;
}

/** Result of a graph traversal. */
export interface GraphQueryResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Contract for the customer intelligence graph store. Implementations MUST
 *  reject any edge whose endpoints belong to different organizations. */
export interface CustomerGraph {
  upsertNode(node: GraphNode): Promise<GraphNode>;
  upsertEdge(edge: GraphEdge): Promise<GraphEdge>;
  neighbors(query: GraphQuery): Promise<GraphQueryResult>;
}
