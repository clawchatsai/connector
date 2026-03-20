/**
 * Minimal ambient type declaration for better-sqlite3.
 *
 * We only declare the surface used by migrate.ts. Install
 * @types/better-sqlite3 for full typings if needed.
 */
declare module 'better-sqlite3' {
  interface Statement {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
  }

  interface Transaction {
    (): void;
  }

  interface Database {
    /** Absolute file path (or ':memory:') */
    readonly name: string;
    exec(sql: string): this;
    prepare(sql: string): Statement;
    transaction(fn: (...args: unknown[]) => void): Transaction;
    close(): void;
  }

  const Database: {
    new (filename: string, options?: object): Database;
    (filename: string, options?: object): Database;
  };

  export default Database;
}
