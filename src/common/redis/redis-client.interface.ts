import type { EventEmitter } from 'node:events';

/**
 * Minimal, transport-agnostic surface of the Redis client used across Bonde.
 *
 * We deliberately do NOT depend on the `ioredis` class type here: ioredis's
 * merged `class + interface` declaration does not resolve as a constructable
 * value/type under TypeScript's `nodenext` ESM rules committed to this repo.
 * Typing against this minimal interface keeps the codebase type-safe for the
 * commands we actually use while remaining resilient to ioredis version churn.
 */
export interface RedisClient extends EventEmitter {
  status: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  quit(): Promise<string>;
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  exists(key: string | string[]): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  pttl(key: string): Promise<number>;
  /** SCAN-based cursor-paginated key iteration (see ioredis `scanIterator`). */
  scanIterator(options?: Record<string, unknown>): AsyncIterableIterator<string>;
}

export type { RedisClient as RedisClientType };
