import { NextRequest, NextResponse } from "next/server";
import { searchContext } from "@/server/pipeline/context-seed";
// 2026-10-25 资产归属: 注入也按请求身份过滤 Memory（Knowledge/Skill 待加列后同法接入）
import { scopeSqlFragment } from "@/server/pipeline/asset-scope";
import { resolveRequestActor } from "@/server/lib/request-actor";
// 2026-10-25: 列存在性探测 —— 窗口前 K/S 不附加过滤（= 旧行为），窗口后自动生效，不需要再改代码
import { hasAssetColumns } from "@/server/lib/asset-columns";

export const dynamic = "force-dynamic";

// GET /api/v1/flywheel/memory/context?query=记忆 知识 技能 定义&theme=飞轮架构&limit=8
// 记忆前置注入: agent(含外部会话)执行任务前应先读这里, 避免"平台存过却没人用"。
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    // 2026-10-10 round 72-AE: source 缺省时**用 User-Agent 兜底**。
    //   为什么: 实测 30 分钟 42 次注入里 23 次(55%)无调用者标识, 而生产模式下请求日志已消失,
    //   等于那块注入是谁在调**没有任何观测手段**。逐个调用方补 source 最干净但要协作、要等;
    //   UA 兜底**不需要任何调用方配合**即立刻生效(能立刻分出 dsh/agent、python 脚本、curl、浏览器)。
    //   放在这里而不是 searchContext 里: UA 是 HTTP 层的东西, 非 HTTP 调用方(内部 worker)不该被硬塞。
    // 2026-10-25: 无 key=匿名（只能拿到 无主/global），带 key=该身份，bad key=401；x-admin-key=root_admin。
    const who = await resolveRequestActor(req);
    if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
    const scopeSql = scopeSqlFragment(who.actor, "memory");
    const ksScope: { knowledge?: string; skill?: string } = {};
    if (await hasAssetColumns("knowledge")) ksScope.knowledge = scopeSqlFragment(who.actor, "knowledge");
    if (await hasAssetColumns("skill")) ksScope.skill = scopeSqlFragment(who.actor, "skill");

    const ua = String(req.headers.get("user-agent") || "").trim();
    const src = sp.get("source") || (ua ? "ua:" + ua.slice(0, 24) : undefined);
    const hits = await searchContext({
      query: sp.get("query") || "",
      theme: sp.get("theme") || undefined,
      limit: parseInt(sp.get("limit") || "8", 10) || 8,
      kinds: (sp.get("kinds") ? sp.get("kinds")!.split(",") as any : undefined),
      // 2026-10-26 C2: 注入事件带上调用者身份（此前恒为 null，无法归因）
      agentId: (who.actor && who.actor.agentId) || null,
      // 2026-09-22 知识库结构化整理(步骤3): tags/domain 检索参数(向后兼容)
      tags: sp.get("tags") || undefined,
      domain: sp.get("domain") || undefined,
      // 2026-10-10 round 72-Z: **诊断类调用不计数**。
      //   实测(72-Y): pre-commit 的端点冒烟对每次改动 mind 的提交都会带 query=smoke 调一次本接口 ——
      //   今天为修数据库损坏反复提交, 同一批对象被反复 +1 使用计数(日志里 query=smoke 出现 89 次);
      //   探针告警(拿告警标题当检索词)与排障查询同理。这三类**不是 agent 的工作性注入**,
      //   却和真正的注入混在同一个 sourceId 下、同样计入"记忆被使用" —— 这是 accessCount 虚高的直接来源。
      //   约定: 默认仍计数(scoped 到本接口, 向后兼容); 诊断类调用显式带 countUsage=false, 照常返回结果。
      countUsage: sp.get("countUsage") !== "false",
      // 2026-10-10 round 72-AB: 调用者身份(见 context-seed 里同轮注释)。生产模式丢掉了请求日志,
      //   这个参数现在是回答「谁在反复调检索接口」的唯一手段。
      source: src,
      // 2026-10-25: 注入侧归属过滤（仅 Memory；K/S 待列）
      scopeSql,
      scopeSqlByKind: ksScope,
    });
    return NextResponse.json({ ok: true, count: hits.length, hits });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
