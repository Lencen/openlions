"use client";
// 0.5.1 B5-12 /agents/session-browser · Bento P2 详情（2026-11-15）
// 数据：GET /api/session-detail/<sessionUid>（**必须 sessionUid，含冒号需 encode**；用 Session.id 会 404）。
// 口径：?id= 为会话标识；缺 id → 「缺少会话标识」；未找到 → 「未找到会话」；本页只读。
import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import type { Metric } from "@/components/bento/types";
import { BentoKpi, BentoState } from "@/components/bento";
import { Chips, Note, States, Tone, usePhaseOverride, useResource } from "../../system/_components/bento-kit";
import kit from "../../system/_components/bento-kit.module.css";
import { fmtNum, fmtTime } from "@/lib/format";

interface DetailMessage { messageUid: string; role: string; content: string; createdAt?: string | null; timestamp?: string | null; model?: string | null }
interface DetailPayload {
  session?: { sessionUid: string; agentId?: string | null; source?: string | null; title?: string | null; status?: string | null; messageCount?: number; totalMessages?: number; startedAt?: string | null; lastMessageAt?: string | null; updatedAt?: string | null; model?: string | null; platform?: string | null };
  totalMessages?: number; messagesTruncated?: boolean; messages?: DetailMessage[]; error?: string;
}
const roleLabel = (r: string) => r === "user" ? "用户" : r === "assistant" ? "智能体" : r === "system" ? "系统" : r || "工具";

export default function SessionBrowserPage() {
  const [uid, setUid] = useState<string | null>(null);
  useEffect(() => {
    try { setUid((new URLSearchParams(window.location.search).get("id") || "").trim()); } catch { setUid(""); }
  }, []);
  const forced = usePhaseOverride();

  return (
    <main className="page">
      <h1 className={kit.srOnly}>会话浏览器</h1>
      <PageHeader>
        <PageTitle>会话浏览器</PageTitle>
        <div className="page-subtitle">
          会话标识回显：<span className={kit.mono}>{uid ? uid : "n/a（未提供 ?id=）"}</span> · 只读
        </div>
        <Chips group="智能体" page="会话浏览" />
      </PageHeader>
      {uid === null ? <BentoState phase="loading" /> : uid ? <DetailView uid={uid} forced={forced} /> : (
        <BentoState phase="empty" title="缺少会话标识" detail={<>本页需要会话标识：<span className={kit.mono}>/agents/session-browser?id=&lt;sessionUid&gt;</span>。可从 <Link href="/agents/sessions" className={kit.link}>会话归档</Link> 进入。</>} />
      )}
    </main>
  );
}

function DetailView({ uid, forced }: { uid: string; forced: ReturnType<typeof usePhaseOverride> }) {
  const res = useResource<DetailPayload>("/api/session-detail/" + encodeURIComponent(uid));
  const base = forced && forced !== "ok" ? forced : res.phase;
  const d = res.data;
  const s = d?.session;
  const notFound = base === "ok" && (!s || d?.error);
  const phase = res.status === 404 ? "unavailable" : notFound ? "unavailable" : base;
  const messages = d?.messages ?? [];
  const asOf = s?.lastMessageAt || s?.updatedAt || null;

  const k = (v: number | null | undefined, hint: string): Metric =>
    v == null ? { kind: "na", reason: "接口未下发" } : { kind: "value", value: fmtNum(v), hint };

  return (
    <>
      <States phase={phase} endpoint={"GET /api/session-detail/" + uid} error={res.error} status={res.status} onRetry={res.reload}
        emptyTitle="未找到会话" emptyDetail="会话服务返回空会话（空集/未找到）。"
        unavailableTitle={res.status === 404 ? "未找到该会话" : "会话服务暂不可用"} unavailableDetail={res.status === 404 ? "未找到该会话：会话服务返回 404，请确认 sessionUid（含冒号需 encode）或返回会话归档重选。" : (d?.error || "会话服务无对应会话（可能是历史归档登记）；会话标识须用 sessionUid（含冒号需 encode）。")} />

      {phase === "ok" && s && (
        <BentoGrid>
          <BentoCard span={8} title="消息流" sub={(d?.messagesTruncated ? "已截断展示" : "按时间顺序") + " · 共 " + fmtNum(s.messageCount ?? d?.totalMessages ?? messages.length) + " 条"}>
            {messages.length ? (
              <ul className={kit.msgList}>
                {messages.map((m, i) => (
                  <li key={m.messageUid || i} className={kit.msgItem} data-role={m.role}>
                    <div className={kit.msgHead}>
                      <Tone tone={m.role === "assistant" ? "ok" : m.role === "user" ? "info" : "mute"}>{roleLabel(m.role)}</Tone>
                      <span className={kit.mono}>{m.createdAt || m.timestamp || "n/a"}</span>
                      {m.model ? <span className={kit.mono}>{m.model}</span> : null}
                    </div>
                    <div className={kit.msgBody}>{m.content?.length > 3000 ? m.content.slice(0, 3000) + "…（已截断）" : (m.content || "(空消息)")}</div>
                  </li>
                ))}
              </ul>
            ) : <BentoState phase="empty" title="该会话暂无消息" detail="会话服务返回 0 条消息（空集，不是不可得）。" />}
          </BentoCard>

          <BentoCard span={4} title="会话摘要">
            <BentoKpi label="消息数" metric={k(s.messageCount ?? d?.totalMessages, "session.messageCount / totalMessages")} />
            <ul className={kit.kv}>
              <li><span>会话 UID</span><b className={kit.mono}>{s.sessionUid}</b></li>
              <li><span>智能体</span><b>{s.agentId || "n/a"}</b></li>
              <li><span>状态</span><b>{s.status || "n/a"}</b></li>
              <li><span>来源</span><b>{s.source || "n/a"}</b></li>
              <li><span>平台</span><b>{s.platform || "n/a"}</b></li>
              <li><span>开始</span><b>{s.startedAt ? fmtTime(s.startedAt) : "n/a"}</b></li>
              <li><span>最近消息</span><b>{s.lastMessageAt ? fmtTime(s.lastMessageAt) : "n/a"}</b></li>
              <li><span>更新</span><b>{s.updatedAt ? fmtTime(s.updatedAt) : "n/a"}</b></li>
            </ul>
          </BentoCard>

          <BentoCard span={12} title="相关视图">
            <ul className={kit.kv}>
              <li><span>会话归档</span><b><Link href="/agents/sessions" className={kit.link}>/agents/sessions</Link>（智能体会话列表）</b></li>
              <li><span>会话中心</span><b><Link href="/sessions" className={kit.link}>/sessions</Link> · 详情 <Link href={"/sessions/detail?id=" + encodeURIComponent(uid)} className={kit.link}>/sessions/detail</Link></b></li>
              <li><span>关联任务</span><b>n/a —— 会话详情接口未返回任务关联字段</b></li>
              <li><span>数据时刻</span><b>{asOf ? fmtTime(asOf) : "n/a（接口未下发）"} · 本页只读</b></li>
            </ul>
            <Note>注意：会话标识必须用会话唯一标识（形如 <span className={kit.mono}>智能体:来源:run_xxx</span>，含冒号需转义）；用会话内部编号会找不到。</Note>
          </BentoCard>
        </BentoGrid>
      )}
    </>
  );
}