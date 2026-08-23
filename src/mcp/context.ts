// Per-process request context: the DB pool and loaded Config, made
// available to tool handlers without threading them through every call
// signature. The MCP protocol revision this server targets (2026-07-28)
// is stateless — there is no per-session state here, only the two
// process-wide singletons (pool, config) every request reads.
import type { Pool } from 'pg';
import type { Config } from '../config/env.js';
import { getPool, initPool } from '../db/pool.js';

let config: Config | undefined;

export function initContext(cfg: Config): void {
  config = cfg;
  initPool(cfg);
}

export function getConfig(): Config {
  if (!config) {
    throw new Error('Context not initialized — call initContext(config) at process startup');
  }
  return config;
}

export function getDb(): Pool {
  return getPool();
}
