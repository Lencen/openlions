/**
 * session-pg.selftest.ts — 证明「PG 断开不会打死 mind」（2026-11-19 [team]，P0-2）
 *
 * 为什么需要：node-postgres 的空闲连接在 PG 侧断开时会 emit("error")；EventEmitter 的 error 无监听
 *   会被抛成 unhandled error -> 整个 mind 进程退出。修法是 pool.on("error") 只记日志不退出。
 *   本自检**真的**断开一次连接（终结自己池里的后端 pg_backend_pid），验四件事：
 *     ① 能取到池内后端 pid
 *     ② 能从另一连接终结它（模拟 PG 重启断开空闲连接）
 *     ③ 出现 idle client error 日志（错误可见，不是静默）
 *     ④ 下一条查询自动重建连接成功；且进程活到打印 PASS 行（证明没被 unhandled error 打死）
 *
 * 判据：cd packages/apps/mind && ../../../node_modules/.bin/tsx src/server/lib/session-pg.selftest.ts
 *   期望末尾 `PASS=4 FAIL=0` + exit 0。需要 run/pg-password（或 SESSION_DATABASE_URL）可读。
 *   副作用：仅关闭本进程自己的一条连接（pg_terminate_backend 自己的 pid，非超级用户也允许）；不写库。
 */
import fs from "fs";
import { Client } from "pg";
import { sessionQuery } from "./session-pg";

let pass = 0;
let fail = 0;
const lines: string[] = [];
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { pass++; console.log(`PASS ${name}${extra ? " " + extra : ""}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? " " + extra : ""}`); }
}

function connectionString(): string {
  if (process.env.SESSION_DATABASE_URL) return process.env.SESSION_DATABASE_URL;
  const f = process.env.LIONS_PG_PASSWORD_FILE || "~/lions/run/pg-password";
  const pw = fs.readFileSync(f, "utf8").trim();
  return "postgresql://lions:" + encodeURIComponent(pw) + "@127.0.0.1:5432/lions_session";
}

async function main(): Promise<void> {
  const origErr = console.error;
  (console as any).error = (...a: any[]) => { lines.push(a.map(String).join(" ")); origErr(...a); };

  const rows = await sessionQuery<{ pid: number }>("select pg_backend_pid() as pid");
  const pid = rows[0].pid;
  ok("① 取到池内后端 pid", Number.isInteger(pid) && pid > 0, `pid=${pid}`);

  const killer = new Client({ connectionString: connectionString() });
  await killer.connect();
  const k = await killer.query("select pg_terminate_backend($1) as ok", [pid]);
  ok("② 已终结该后端（模拟 PG 断开空闲连接）", k.rows[0].ok === true);

  await new Promise((r) => setTimeout(r, 1500));
  ok("③ 出现 idle client error 日志（错误可见，未静默）", lines.some((l) => l.includes("idle client error")),
    lines.length ? "首行=" + lines[0].slice(0, 90) : "无日志");

  let recovered = false;
  try {
    const again = await sessionQuery<{ x: number }>("select 1 as x");
    recovered = again[0].x === 1;
  } catch (e: any) { recovered = false; lines.push("recover_fail " + e.message); }
  ok("④ 断开后新查询自动重建连接", recovered);

  await killer.end();
  console.log("---");
  console.log(`PASS=${pass} FAIL=${fail}（进程活到这一行即证明未被 unhandled error 打死）`);
}

main().then(() => process.exit(fail === 0 ? 0 : 1)).catch((e) => { console.error("FATAL", e && e.message); process.exit(2); });