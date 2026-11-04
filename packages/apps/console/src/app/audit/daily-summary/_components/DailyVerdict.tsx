"use client";
// 2026-10-26：日报的「一句话结论」——先给判断，再给数据。
// 评审结论：日报不该是"一堆并列指标"，要按业务顺序回答四问：
//   今天产出了什么 → 质量如何 → 谁在产出 → 需要我做什么。
// 这一栏就是第一个答案，其余板块都是它的证据。
import type { DailyReport } from "./shared";
import Icon from "@/components/Icon";
import Link from "next/link";

const TABLES: { key: string; label: string }[] = [
  { key: "Memory", label: "记忆" },
  { key: "Knowledge", label: "知识" },
  { key: "Reflection", label: "反思" },
  { key: "Practice", label: "实践" },
  { key: "Skill", label: "技能" },
];

export default function DailyVerdict({ d }: { d: DailyReport }) {
  const prod = d.production || {};
  const total = TABLES.reduce((s, t) => s + Number((prod as any)[t.key]?.today || 0), 0);
  const prev = TABLES.reduce((s, t) => s + Number((prod as any)[t.key]?.prev || 0), 0);
  const delta = total - prev;
  const q = d.quality || {};
  const high = Number(q.high || 0);
  const low = Number(q.low || 0);
  const over = (d.overCapacity || []).length;
  const pending = (d.tasks?.pending || []).reduce((s, x: any) => s + Number(x.count || 0), 0);
  const errs = (d.errors || []).reduce((s, x: any) => s + Number(x.count || 0), 0);
  const todo = over + pending + errs;
  const unavailable = (d as any).warning === "data_unavailable";

  const state = unavailable ? "idle" : total === 0 ? "idle" : todo > 20 ? "warn" : "ok";
  const headline = unavailable
    ? "今天的数据没取到，先别据此判断"
    : total === 0
      ? "今天还没有新产出"
      : todo > 20
        ? `今天产出 ${total} 条，有 ${todo} 件需要人处理`
        : `今天产出 ${total} 条，节奏正常`;

  return (
    <div className="dv-strip" data-state={state}>
      <Icon name={state === "ok" ? "check" : state === "warn" ? "alert" : "inbox"} size={16} />
      <span className="dv-headline">{headline}</span>
      {/* 2026-10-26 R7（老板点名「关键数字要看得到、点得进去」）：每个数字都能下钻。
          只有语义能对上的才给链接（不做"点了但筛不上"的假入口）：
            · 高分 → 记忆库 quick=highQuality（qualityScore ≥ 0.7，与报表同口径）
            · 低分 → 记忆库 quick=pendingReview（qualityScore < 0.4，与报表同口径）
            · 待办 → /todo?owner=human（该页支持服务端按负责人过滤）
            · 产出/超容 → 记忆库（无对应 URL 筛选，落列表后自行筛，tooltip 说明）
            · 错误 → 飞轮日志（页内有级别过滤） */}
      <span className="dv-facts">
        <span>较前一日 <b className={delta > 0 ? "up" : delta < 0 ? "down" : ""}>{delta > 0 ? "+" : ""}{delta}</b></span>
        <span>
          高分 <Link className="dv-link" href="/cognitive/memory?quick=highQuality" title="跳到记忆库：质量分 ≥ 0.7">{high}</Link>
          {" · "}低分 <Link className="dv-link" href="/cognitive/memory?quick=pendingReview" title="跳到记忆库：质量分 < 0.4">{low}</Link>
        </span>
        <span>
          超容主题 <Link className="dv-link" href="/cognitive/memory" title="跳到记忆库（超容主题暂无 URL 筛选，落列表后按主题看）">{over}</Link>
          {" · "}待办 <Link className="dv-link" href="/todo?owner=human" title="跳到待办中心：只要我（人类）处理的">{pending}</Link>
          {" · "}错误 <Link className="dv-link" href="/flywheel/logs" title="跳到飞轮日志（可按级别筛错误）">{errs}</Link>
        </span>
      </span>
    </div>
  );
}
