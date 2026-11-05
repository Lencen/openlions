"use client";
// 2026-10-20 首页业务闭环（环形版，人类要求"只要关键节点、讲清流向与变化、闭环且增长"）。
// 结构：claim 一句话 + 状态灯 + 环形闭环（LoopFlow）+ 3 个可点 KPI。
// 细节（守门/运维/7 段管线）不进这一屏 —— 它们在同页「展开更多数据」里。
import Link from "next/link";
import { useApi } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import LoopRing from "./LoopRing";
import LayerTrends from "./LayerTrends";
import styles from "../page.module.css";

export default function OverviewOneScreen({ data, loading }: { data: any; loading: boolean }) {
  const { data: todo } = useApi<any>("/api/todos?ownerType=human&limit=1");
  const { data: loop } = useApi<any>("/api/business-loop");
  const { data: stuck } = useApi<any>("/api/task-stuck");
  const s = data?.sessions || {}, p = data?.products || {}, b = data?.backlog || {}, a = data?.agents || {};
  const q = data?.quality?.byTable || {};
  const pull = loop?.pull;
  const tables = Object.values(p.byTable || {}) as any[];
  // 2026-10-21 对账：用各表 n（WHERE createdAt > since 的精确计数）求和，而不是趋势桶求和——
  //   趋势桶会丢掉"最后一个不完整小时"里的行（实测 Memory n=857 而桶和 809，少 48）。
  const added24 = tables.reduce((acc: number, x: any) => acc + (Number(x?.n) || 0), 0);
  const qv = Object.values(q) as any[];
  const avgQ = qv.length ? qv.reduce((acc: number, v: any) => acc + (Number(v?.avg) || 0), 0) / qv.length : 0;
  // 2026-10-22 修：接口里个别计数字段可能返回对象（聚合包装）或 null，
  //   之前直接字符串拼接导致页面上出现「会话 · 失败 [object Object]」。
  //   这里统一取值：数字直接用；对象/未知一律显示「—」，宁可不显示也不显示假数字。
  const asNum = (v: any): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
    return null;
  };
  const showNum = (v: any): string => {
    const n = asNum(v);
    return n === null ? "—" : String(n);
  };
  const humanOpen = Number(todo?.humanOpen ?? 0);
  const consumeTotal = (pull?.agentCalls ?? 0) + (pull?.platformCalls ?? 0);

  // 2026-10-20 R11：原来这句话把 会话/资产总量/新增/取用 又抄了一遍，与环上节点和中心重复 3 次。
  //   改成"这屏在讲什么"的一句话（叙事），数字交给节点与中心各出现一次。
  const claim = loading || !data ? "正在读取今天的业务状态…" : "";

  return (
    <section className={"panel " + styles.osSection}>
      {/* 2026-10-25 R5: 去掉这句叙事 claim —— 业务环自己的头部已给出结论（"整体转得顺/有 N 环需要留意"），
          两句都说一遍等于重复，而且它把环挤到了首屏之外（实测 ring bottom 943 > 900）。 */}
      <div className="os-lights">
        {[{ k: "会话", ok: (asNum(b.failedSessions) ?? 0) === 0, v: "失败 " + showNum(b.failedSessions) },
          { k: "认知", ok: (asNum(q.Memory?.low) ?? 0) <= (asNum(q.Memory?.high) ?? 0) * 2, v: "低分 " + showNum(q.Memory?.low) },
          { k: "智能体", ok: (asNum(a.active) ?? 0) > 0, v: "活跃 " + showNum(a.active) + "/" + showNum(a.total) }].map((l) => (
          <span key={l.k} className="os-light"><span className={"os-dot" + (l.ok ? "" : " warn")} />{l.k} · {l.v}</span>
        ))}
        <span className="os-light"><span className="os-dot" />数据时间 {data?.asOf ? new Date(data.asOf).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</span>
      </div>

      {/* 2026-10-25 R5: 业务环换成 LoopRing（每节点带状态, 环段=流转状态, 环心=结论+主数+⑥快照）。
          旧 LoopFlow 的「👤作/审/纠」图例是 emoji + 解释性文案, 一并去掉（信息已并入节点卡说明）。 */}
      <LoopRing />

      {/* 2026-10-20 R11：三张卡原来分别重复了 需要你决定(与中心药丸重复)、平均质量(与中心重复)。
          改成三个"只有这里有"的问题入口：未消化会话 / 卡住的改进任务 / 低分资产。 */}
      <div className="os-kpis">
        <Link className="os-kpi" href="/system/access-log">
          <span className="os-kpi-k">未消化会话</span><span className="os-kpi-v">{fmtNum((b.pendingSessions ?? 0) + (b.failedSessions ?? 0))}</span>
          <span className="os-kpi-h">待提炼 {fmtNum(b.pendingSessions ?? 0)} · 失败 {fmtNum(b.failedSessions ?? 0)}</span>
        </Link>
        <Link className="os-kpi" href="/flywheel/improvement-results">
          <span className="os-kpi-k">卡住的改进任务</span><span className="os-kpi-v">{fmtNum(stuck?.stuck7 ?? 0)}</span>
          <span className="os-kpi-h">超过 7 天没有任何动作{stuck?.oldestDays ? " · 最久 " + stuck.oldestDays + " 天" : ""}</span>
        </Link>
        <Link className="os-kpi" href="/cognitive/memory">
          <span className="os-kpi-k">低分资产</span><span className="os-kpi-v">{fmtNum((q.Memory?.low ?? 0) + (q.Knowledge?.low ?? 0) + (q.Practice?.low ?? 0) + (q.Reflection?.low ?? 0) + (q.Skill?.low ?? 0))}</span>
          <span className="os-kpi-h">质量分 &lt;0.4 · 点进记忆库治理</span>
        </Link>
      </div>

      <LayerTrends data={data} />
    </section>
  );
}