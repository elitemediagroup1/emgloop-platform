// Messaging repositories — Sprint 4 (Real Data Layer).
//
// In the canonical schema, a Message always belongs to a Conversation. The
// Sprint 3 in-memory store flattened this; the real data layer restores it.
// ConversationRepository lazily ensures a conversation exists for a customer
// so the loop can persist SMS without managing conversation lifecycle itself.

import type {
  PrismaClient,
  Conversation,
  Message,
  ChannelType,
  ActorType,
} from '@prisma/client';

export class ConversationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(args: {
    organizationId: string;
    customerId?: string | null;
    channel: ChannelType;
    subject?: string | null;
  }): Promise<Conversation> {
    return this.prisma.conversation.create({
      data: {
        organizationId: args.organizationId,
        customerId: args.customerId ?? null,
        channel: args.channel,
        subject: args.subject ?? null,
      },
    });
  }

  /** Return the open conversation for a customer/channel, creating one if none. */
  async ensureForCustomer(args: {
    organizationId: string;
    customerId: string;
    channel: ChannelType;
    subject?: string | null;
  }): Promise<Conversation> {
    const existing = await this.prisma.conversation.findFirst({
      where: {
        organizationId: args.organizationId,
        customerId: args.customerId,
        channel: args.channel,
        status: 'OPEN',
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing;
    return this.create(args);
  }
}

export class MessageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(args: {
    organizationId: string;
    conversationId: string;
    actorType: ActorType;
    actorId?: string | null;
    body: string;
    provider?: string | null;
    externalId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<Message> {
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          organizationId: args.organizationId,
          conversationId: args.conversationId,
          actorType: args.actorType,
          actorId: args.actorId ?? null,
          body: args.body,
          provider: args.provider ?? null,
          externalId: args.externalId ?? null,
          metadata: (args.metadata ?? {}) as object,
        },
      });
      await tx.conversation.update({
        where: { id: args.conversationId },
        data: { lastMessageAt: message.sentAt },
      });
      return message;
    });
  }

  listForConversation(conversationId: string): Promise<Message[]> {
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'asc' },
    });
  }
}
