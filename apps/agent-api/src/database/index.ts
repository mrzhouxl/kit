/**
 * database/index.ts — 数据库模块统一导出
 */
export { db, closeDatabase, testConnection } from "./connection.js";
export { runMigrations } from "./migrate.js";
export * from "./schema.js";
