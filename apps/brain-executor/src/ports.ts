// What the runner needs from its environment, as ports. Slice B6.
//
// The runtime code in this package depends only on these interfaces. The AWS adapters
// (queues, the replay ledger, the key service, secrets, parameters) live in infra/brain,
// and tests use in-memory versions. Nothing here names a cloud provider's SDK.

import type { AiControlFloor, BrainAdvanceMessage } from '@emgloop/shared';
import type { BrainExecutorStore } from '@emgloop/database/src/services/brain/brain-executor-store';
import type { BrainExecutionReferences } from '@emgloop/database/src/repositories/brain/brain-execution-references';

export type BrainQueueName = 'INTERACTIVE' | 'DURABLE';

export interface BrainWorkQueues {
  send(queue: BrainQueueName, message: BrainAdvanceMessage, options?: { readonly delaySeconds?: number }): Promise<{ readonly messageId: string }>;
}

/** Records a doorbell token id once. False means it was already used. */
export interface BrainReplayLedger {
  recordOnce(tokenId: string, expiresAtSeconds: number): Promise<boolean>;
}

/** The store surfaces each component uses, and no more. */
export type BrainDispatcherStore = Pick<BrainExecutorStore, 'command' | 'markDispatched'>;
export type BrainWorkerStore = Pick<
  BrainExecutorStore,
  | 'resolve'
  | 'command'
  | 'claim'
  | 'release'
  | 'addActiveTime'
  | 'controlsFor'
  | 'transition'
  | 'stopByPolicy'
  | 'stepState'
  | 'beginStep'
  | 'checkpoint'
  | 'readCheckpoint'
  | 'failStep'
  | 'waitForUser'
  | 'resumeAfterReply'
  | 'expireWait'
>;
export type BrainSweeperReferences = Pick<BrainExecutionReferences, 'undispatchedCommands' | 'expiredWaits' | 'staleLeases' | 'locateJob'>;

/** Hands a lost command to the dispatcher, which alone records a dispatch. */
export interface BrainDispatcherInvoker {
  recover(commandId: string): Promise<void>;
}

/** Runtime switches read from the deployment, never from a request. */
export interface BrainRuntimeSwitches {
  /** The worker switch. False stops every job at its next boundary. */
  workerEnabled(): Promise<boolean>;
  /** This deployment's AI floor. Unreadable means stopped. */
  aiFloor(): Promise<AiControlFloor>;
}
