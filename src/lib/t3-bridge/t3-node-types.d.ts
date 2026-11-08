/**
 * Types the vendored T3 layer reads that this repo's @types/node (and TS 5.9 lib) do not declare.
 * Runtime is unchanged: T3 checks `typeof writer.setAuthorizer` before using it, so Node 22.16 takes
 * its own path. No vendored file is edited for these.
 */
import 'node:sqlite';

declare module 'node:sqlite' {
  interface DatabaseSync {
    readonly isTransaction: boolean;
    setAuthorizer(callback: ((actionCode: number, ...args: Array<string | null>) => number) | null): void;
  }
  namespace constants {
    const SQLITE_OK: number;
    const SQLITE_DENY: number;
    const SQLITE_FUNCTION: number;
    const SQLITE_PRAGMA: number;
    const SQLITE_READ: number;
    const SQLITE_RECURSIVE: number;
    const SQLITE_SAVEPOINT: number;
    const SQLITE_SELECT: number;
    const SQLITE_TRANSACTION: number;
  }
}

declare global {
  interface ReadableStream<R = unknown> {
    [Symbol.asyncIterator](): AsyncIterableIterator<R>;
  }
}
