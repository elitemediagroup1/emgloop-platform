// @emgloop/brain-executor -- the Brain execution runtime for the AWS deployable (B6).
//
// Record: docs/architecture/brain-aws-foundation.md. This package holds the runtime logic and
// its ports; infra/brain binds the ports to AWS and packages the handlers.

export { BRAIN_EXECUTOR_REVISION, BRAIN_EXECUTION_MODES, BRAIN_EXECUTOR_OBLIGATION_EVIDENCE, brainExecutorObligationsWithoutEvidence } from './revision';
export type { BrainExecutionMode } from './revision';
export { BRAIN_LOG_FIELDS, jsonLogger, memoryLogger } from './log';
export type { BrainLogger, BrainLogFields } from './log';
export { base64url, derToJoseP256, p256PublicKey, pinnedKeysFromJson, sha256Hex, signEs256Jwt, verifyEs256Jwt, JwsError } from './jws';
export type { Es256Signer, JwsVerification } from './jws';
export type {
  BrainDispatcherInvoker,
  BrainDispatcherStore,
  BrainQueueName,
  BrainReplayLedger,
  BrainRuntimeSwitches,
  BrainSweeperReferences,
  BrainWorkerStore,
  BrainWorkQueues,
} from './ports';
export { authorizeRing } from './doorbell-authorizer';
export type { RingAuthorization, RingTrust } from './doorbell-authorizer';
export { BRAIN_RING_MAX_BODY_BYTES, dispatch } from './dispatcher';
export type { DispatchInput, DispatchOutcome } from './dispatcher';
export { BRAIN_LOOP_CALL_TIMEOUT_MS, BRAIN_WORKER_TOKEN_LIFETIME_SECONDS, createLoopClient, loopBaseUrl } from './loop-client';
export type { LoopAccessAnswer, LoopCall, LoopClient, LoopClientConfig, LoopContextAnswer } from './loop-client';
export { BRAIN_DARK_PLAN_VERSION, DARK_CLARIFY_QUESTION, brainTaskMayWait, darkPlan } from './plans';
export type { BrainPlanStep } from './plans';
export { MalformedAdvanceMessage, RetryDelivery, advanceJob } from './worker';
export type { BrainSealerSource, BrainWorkerDeps, BrainWorkerOutcome } from './worker';
export { BRAIN_RING_GRACE_MS, sweep } from './sweeper';
export type { BrainSweepSummary } from './sweeper';
export { BRAIN_FLOOR_STOPPED, checkpointSealerFromSecret, parseAiFloor, parseNameList, parseSwitch } from './config';
