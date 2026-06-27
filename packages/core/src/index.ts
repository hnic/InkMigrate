export const CORE_VERSION = '0.0.0';

// domain
export * from './domain/models.js';
export * from './domain/states.js';
export * from './domain/errors.js';
export * from './domain/capabilities.js';
export * from './domain/plans.js';
export * from './domain/stable-keys.js';

// adapters
export * from './adapters/adapter.js';
export * from './adapters/registry.js';
export {
  isAdapterApiCompatible,
  SUPPORTED_ADAPTER_API_RANGE,
} from './adapters/api-version.js';

// storage
export {
  openDatabase,
  migrate,
  getCurrentSchemaVersion,
  SCHEMA_VERSION,
} from './storage/database.js';
export type { DB } from './storage/database.js';
export * from './storage/repositories/source-instances.js';
export * from './storage/repositories/target-instances.js';
export * from './storage/repositories/migration-jobs.js';
export * from './storage/repositories/source-items.js';
export * from './storage/repositories/target-artifacts.js';
export * from './storage/repositories/migration-attempts.js';
export * from './storage/repositories/cleanup-plans.js';
export * from './storage/repositories/cleanup-jobs.js';
export * from './storage/repositories/cleanup-items.js';
export * from './storage/repositories/cleanup-attempts.js';

// security
export {
  sourceContentHash,
  targetContentHash,
  writtenFileHash,
} from './security/hashes.js';
export { createRedactor } from './security/redactor.js';
export type { Redactor } from './security/redactor.js';
export { createLogger } from './security/logger.js';
export type { LoggerOptions } from './security/logger.js';
export {
  resolveWithin,
  rejectsTraversal,
  isPathInside,
  assertSymlinkSafe,
} from './security/paths.js';
export { sanitizeFilename } from './security/filenames.js';
export type { SanitizeOptions } from './security/filenames.js';

// config
export { ConfigSchema } from './config/schema.js';
export type { InkMigrateConfig } from './config/schema.js';
export {
  loadConfigFromString,
  ConfigValidationError,
} from './config/loader.js';

// reports
export { writeCsv, escapeCsvField } from './reports/csv-writer.js';

// runtime
export { acquireLock, LockConflictError } from './runtime/locks.js';
export type { AcquireOptions, HeldLock } from './runtime/locks.js';
export {
  isStaleLock,
  type LockFileContent,
} from './runtime/lock-content.js';
export { installSignalHandlers } from './runtime/signals.js';
export type { GracefulShutdownHandlers } from './runtime/signals.js';
export { runMigrationJob } from './runtime/job-runner.js';
export type { JobRunnerInput, JobRunnerResult, JobProgress } from './runtime/job-runner.js';
export { withRetry, DEFAULT_RETRY_POLICY } from './runtime/retry.js';
export type { RetryPolicy } from './runtime/retry.js';
export { withJitter, ITEM_INTERVAL_JITTER, RETRY_BACKOFF_JITTER } from './runtime/jitter.js';
export {
  canTransitionTo,
  isAllowedPauseReason,
  isTerminalStatus,
  canResumeFrom,
} from './runtime/job-state.js';
export { reconcileJob, deriveFinalStateCounts } from './runtime/reconciliation.js';
