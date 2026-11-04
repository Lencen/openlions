import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { asOf, one, openMind } from "@/lib/server/lions-db";
import { macsAdminFetch } from "@/lib/server/macs-admin";

// 2026-10-15 round-78: 读实时数据 —— 上游 mind agent.list **且** build/请求期直读 mind 库
//   (better-sqlite3 readonly)取每个 agent 的 currentTask。冻结快照 = agent 列表与"当前任务"双双停在编译时刻。
//   注: safeFetchJson 的 no-store fetch 使 build 期已 bailout 成动态(但一旦 helper 改动就会静态化) ->
//   显式声明, 同时彻底避免 build 期直读生产库。
export const dynamic = "force-dynamic";

// GET /api/agent-list — mind agent.list + 每 agent 当前工作状态(飞轮改进任务 IN_PROGRESS, 2026-09-08)
// 2026-10-21 Phase 2: 已从 better-sqlite3 直连改为 PG 连接池（lions-db）

export async function GET() {
  // 2026-11-04：安装端口可被 --port-mind 覆盖，不能写死 3000（open/自定义端口会把整页打成 502）。
  const mind = (process.env.LIONS_MIND_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
    const r = await safeFetchJson(mind + "/api/trpc/agent.list?input=%7B%22json%22%3Anull%7D");
  if (r.ok === false) {
    return NextResponse.json({ _error: r.error }, { status: 502 });
  }
  const data = r.data;  const agents = data?.result?.data?.json || data?.result?.data || [];
  // 2026-10-26 修（两个真 bug，都是"静默为空"）：
  //   ① 本路由一直用 `one(sql, param)` 调用，而 lions-db 的签名是 `one(db, sql, ...params)`
  //      → db 位收到的是 SQL 字符串 → db.query 不存在 → 抛错被 catch 吞掉 → 「当前任务」**从来没显示过**；
  //   ② 拿连接池要显式 openMind()。
  const db = openMind();
  const out = await Promise.all(agents.map(async (a: any) => {
    let currentTask: any = null;
    let lastDone: any = null;
    try {
      currentTask = await one(
        db,
        "SELECT id, title, theme, priority, updatedAt FROM Task WHERE status IN ('IN_PROGRESS','PROCESSING') AND assignedAgent = $1 ORDER BY updatedAt DESC LIMIT 1",
        a.agent_id || ""
      );
    } catch { currentTask = null; }
    // 2026-10-26（老板点名「智能体列表信息不全」）：补「最近产物」。
    //   口径：该执行体最近一条**已完成**的改进任务（Task.DONE）——这是它在这个平台上最具体的产物；
    //   取不到就返回 null，界面显示「—」，**不拿 0 或占位文案冒充**（契约：不造假）。
    try {
      lastDone = await one(
        db,
        "SELECT id, title, updatedAt FROM Task WHERE status = 'DONE' AND assignedAgent = $1 ORDER BY updatedAt DESC LIMIT 1",
        a.agent_id || ""
      );
    } catch { lastDone = null; }
    return { ...a, currentTask, lastDone };
  }));
  // 2026-10-15（round 76-FZ, 规范铁律 2）：**给这一页补上"数据时刻"**。
  //   本文件的注释里本来就写着"冻结快照 = agent 列表与当前任务双双停在编译时刻" ✗ ——
  //   也就是说这一页**天生有"数据是什么时候的"这个信息缺口** ✓, 正好是铁律 2 要治的。
  //   形状改为 { asOf, items }（原先返回裸数组 ✗）-> 因此**同步改了全部 4 个消费者** ✓,
  //   且消费者一律用 Array.isArray(x) ? x : x.items 的**容错写法**, 老形状也不会崩 ✓。
  // 2026-10-26 修（老板报「agent-x / agent-x 没显示」）：本页原来只读 mind 的 agent 注册表，
  //   而 MACS 里还有一批在跑的执行体（agent-x / agent-x / agent-x / utc …）没登记进 mind —— 于是列表"看起来缺人"。
  //   现在合并两个来源：mind 注册表为主，MACS 独有的一并列出并标注 source=macs（"未注册进 mind"），
  //   不做静默丢弃；两处都有的，标 source=both 并带上 MACS 的在线状态。
  let macsAgents: any[] = [];
  try {
    const m = await macsAdminFetch("/api/agents");
    const list = (m.body && (m.body.agents || m.body.items || m.body)) || [];
    if (Array.isArray(list)) macsAgents = list;
  } catch { macsAgents = []; }

  const byId = new Map<string, any>();
  for (const a of out as any[]) byId.set(String(a.agent_id || ""), { ...a, source: "mind", macsStatus: null });
  for (const ma of macsAgents) {
    const id = String(ma.agent_id || ma.id || "");
    if (!id) continue;
    const cur = byId.get(id);
    if (cur) { cur.source = "both"; cur.macsStatus = ma.status || null; }
    else {
      byId.set(id, {
        agent_id: id, display_name: ma.name || id, channel: ma.channel || ma.runtime || "macs",
        host: ma.host || "", status: ma.status || "UNKNOWN", profile: null,
        last_seen_at: ma.last_seen_at || null, permissions: [],
        currentTask: null, lastDone: null,
        source: "macs", macsStatus: ma.status || null,
      });
    }
  }
  const items = Array.from(byId.values()).sort((x, y) => {
    const rank = (v: any) => (v.source === "both" ? 0 : v.source === "mind" ? 1 : 2);
    return rank(x) - rank(y) || String(x.agent_id).localeCompare(String(y.agent_id));
  });

  return NextResponse.json({ asOf: asOf(), items, sources: { mind: (out as any[]).length, macs: macsAgents.length, merged: items.length } });
}
