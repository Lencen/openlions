declare module "sql.js" {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }
  interface Database {
    run(sql: string): void;
    exec(sql: string): QueryExecResult[];
    close(): void;
  }
  interface QueryExecResult {
    columns: string[];
    values: any[][];
  }
  export default function initSqlJs(): Promise<SqlJsStatic>;
  export { Database };
}