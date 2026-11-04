// 2026-10-14: better-sqlite3 未随包提供类型声明, 且仓库未安装 @types/better-sqlite3。
// 复制既有做法 (packages/apps/mind/src/types/better-sqlite3.d.ts) —— 只声明 lib/mindAuth.ts
// 实际用到的最小 API 面, 运行期行为不变。本目录已有同样用途的 node-cron.d.ts / sql.js.d.ts。
declare module "better-sqlite3" {
  interface Statement {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  }
  interface Database {
    prepare(sql: string): Statement;
    pragma(sql: string): any;
    exec(sql: string): void;
    close(): void;
  }
  interface DatabaseConstructor {
    new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }): Database;
    (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }): Database;
  }
  const Database: DatabaseConstructor;
  export default Database;
}
