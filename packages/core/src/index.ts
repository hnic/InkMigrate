export const CORE_VERSION = '0.0.0';

// storage
export { openDatabase, migrate, getCurrentSchemaVersion, SCHEMA_VERSION } from './storage/database.js';
export type { DB } from './storage/database.js';
