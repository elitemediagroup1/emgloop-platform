/**
 * Work OS - Collaboration Surfaces
 *
 * Comment, Checklist, and Attachment are the surfaces people use *on* a
 * WorkItem. They are modeled as universal sub-entities so every WorkItem, of
 * any kind, gains them for free. None of these carry files or run I/O; an
 * Attachment is a reference (a pointer), never a blob. Storage is out of scope
 * for a contracts package.
 *
 * Pure contracts only.
 */

import type {
  AttachmentId,
  ChecklistId,
  ChecklistItemId,
  CommentId,
  WorkItemId,
} from "./identifiers";
import type { ActorRef } from "./actors";

/** A threaded comment on a WorkItem. */
export interface Comment {
  readonly id: CommentId;
  readonly workItemId: WorkItemId;
  readonly author: ActorRef;
  readonly body: string;
  readonly createdAt: string;
  readonly editedAt?: string;
  /** Parent comment id for threading, if this is a reply. */
  readonly replyTo?: CommentId;
  /** Actors explicitly mentioned in the body. */
  readonly mentions?: readonly ActorRef[];
}

/** A single checkable line inside a Checklist. */
export interface ChecklistItem {
  readonly id: ChecklistItemId;
  readonly label: string;
  readonly checked: boolean;
  readonly checkedBy?: ActorRef;
  readonly checkedAt?: string;
}

/** An ordered list of checkable items attached to a WorkItem. */
export interface Checklist {
  readonly id: ChecklistId;
  readonly workItemId: WorkItemId;
  readonly title?: string;
  readonly items: readonly ChecklistItem[];
}

/** The kinds of thing an Attachment can point at. Provider-neutral. */
export const ATTACHMENT_KINDS = ["file", "link", "reference"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/**
 * An Attachment is always a *reference*, never file bytes. `uri` is opaque to
 * the Work OS: it may point at object storage, an external URL, or another Loop
 * entity. Keeping this a pointer is what keeps the package free of persistence
 * and I/O.
 */
export interface Attachment {
  readonly id: AttachmentId;
  readonly workItemId: WorkItemId;
  readonly kind: AttachmentKind;
  readonly name: string;
  /** Opaque locator. Resolution is a runtime concern, not this package's. */
  readonly uri: string;
  readonly mimeType?: string;
  readonly addedBy?: ActorRef;
  readonly addedAt?: string;
}
