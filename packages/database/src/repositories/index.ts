// Repository layer barrel — Sprint 4 (Real Data Layer).
//
// One import surface for the whole platform's persistence. The loop engine,
// seed scripts, and (eventually) API routes depend on these classes, never on
// the Prisma client directly. This keeps queries centralized and testable and
// preserves the architecture: providers handle the OUTSIDE world, repositories
// handle the DATABASE, and the loop engine orchestrates between them.

import type { PrismaClient } from '@prisma/client';

import { CustomerRepository } from './customer.repository';
import { InteractionRepository } from './interaction.repository';
import { BookingRepository } from './booking.repository';
import { SignalRepository } from './signal.repository';
import { DomainEventRepository } from './domain-event.repository';
import {
  ConversationRepository,
  MessageRepository,
} from './messaging.repository';
import { AIEmployeeRepository } from './ai-employee.repository';

export * from './types';
export { CustomerRepository, customerDisplayName } from './customer.repository';
export { InteractionRepository } from './interaction.repository';
export { BookingRepository } from './booking.repository';
export { SignalRepository, signalTypeFromLabel } from './signal.repository';
export { DomainEventRepository } from './domain-event.repository';
export {
  ConversationRepository,
  MessageRepository,
} from './messaging.repository';
export { AIEmployeeRepository } from './ai-employee.repository';

export interface Repositories {
  customers: CustomerRepository;
  interactions: InteractionRepository;
  bookings: BookingRepository;
  signals: SignalRepository;
  domainEvents: DomainEventRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  aiEmployees: AIEmployeeRepository;
}

/**
 * Build the repository bundle from a Prisma client. Use the shared singleton
 * from `@emgloop/database` in app code; pass a dedicated client in tests.
 */
export function createRepositories(prisma: PrismaClient): Repositories {
  return {
    customers: new CustomerRepository(prisma),
    interactions: new InteractionRepository(prisma),
    bookings: new BookingRepository(prisma),
    signals: new SignalRepository(prisma),
    domainEvents: new DomainEventRepository(prisma),
    conversations: new ConversationRepository(prisma),
    messages: new MessageRepository(prisma),
    aiEmployees: new AIEmployeeRepository(prisma),
  };
}
