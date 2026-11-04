// 2026-09-10: better-sqlite3 无内置类型声明 (mind 侧首次直连 session DB 只读查询)
// 仅需最小声明以满足 tsc; 运行期 API 见 better-sqlite3 官方文档。
declare module "better-sqlite3" {
  interface Statement {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  }
  interface Database {
    prepare(sql: string): Statement;
    pragma(sql: string, options?: { simple?: boolean }): any;
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
