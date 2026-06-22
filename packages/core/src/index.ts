export const CORE_VERSION = '0.0.0';

// storage
export { openDatabase, migrate, getCurrentSchemaVersion, SCHEMA_VERSION } from './storage/database.js';
export type { DB } from './storage/database.js';
export * from './storage/repositories/source-instances.js';
export * from './storage/repositories/target-instances.js';
export * from './storage/repositories/migration-jobs.js';
export * from './storage/repositories/source-items.js';
export * from './storage/repositories/target-artifacts.js';
export * from './storage/repositories/migration-attempts.js';
