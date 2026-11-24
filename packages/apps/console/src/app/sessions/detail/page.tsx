// 0.5.1 B1-6 /sessions/detail · Bento P2 详情（2026-11-15）
// slots：页头(编号+数据时刻+chips) → s8 消息时间线 + s4 会话信息；只读。
// 数据：/api/session-detail/<uid>（BFF→3002）；缺字段 n/a+原因，不写 0。
import Link from "next/link";
import { headers } from "next/headers";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import BentoState from "@/components/bento/BentoState";
import { fmtStamp as fmtTs } from "@/lib/format";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

interface DetailMessage { messageUid: string; role: string; content: string; createdAt: string | null; model?: string | null }
interface DetailPayload {
  session?: { sessionUid: string; agentId?: string | null; title?: string | null; status?: string | null; messageCount?: number; lastMessageAt?: string | null; updatedAt?: string | null; startedAt?: string | null };
  totalMessages?: number; messagesTruncated?: boolean; messages?: DetailMessage[]; error?: string;
}
const roleLabel = (r: string) => r === "user" ? "用户" : r === "assistant" ? "智能体" : r === "system" ? "系统" : r || "工具";

export default async function SessionDetailPage({ searchParams }: { searchParams?: { id?: string } }) {
  const id = (searchParams?.id || "").trim();
  let data: DetailPayload | null = null;
  let fetchFailed = false;
  if (id) {
    try {
      const h = headers();
      const host = h.get("host") || "127.0.0.1:" + (process.env.PORT || "3004");
      const res = await fetch("http://" + host + "/api/session-detail/" + encodeURIComponent(id), { cache: "no-store" });
      data = (await res.json()) as DetailPayload;
      if (!res.ok) data = { error: data?.error || "BFF HTTP " + res.status };
    } catch { fetchFailed = true; }
  }
  const s = data?.session;
  const messages = data?.messages ?? [];
  const asOf = s?.lastMessageAt || s?.updatedAt || null;

  return (
    <main className="page">
      <h1 className={styles.srOnly}>会话详情</h1>
      <PageHeader>
        <PageTitle>会话详情</PageTitle>
        <div className="page-subtitle">单会话的消息、事件与产出</div>
        <div className={styles.chips} aria-label="页面层级"><span>#</span><span>会话</span><span>详情</span><span className={styles.crumbOn}>只读</span></div>
      </PageHeader>
      <div className={styles.meta}>编号：<span className="mono">{id || "n/a"}</span> · 数据时刻：{asOf ? fmtTs(asOf) : "n/a（接口未下发）"}</div>

      {!id && <BentoState phase="empty" title="缺少会话参数" detail="请从会话中心选择一条会话进入。" />}
      {fetchFailed && <BentoState phase="error" title="会话详情暂不可用" detail="BFF /api/session-detail 连接失败，请稍后重试。" />}
      {!fetchFailed && data?.error && <BentoState phase="unavailable" title="未找到该会话" detail={data.error + " —— 可能是历史归档登记（会话服务 3002 无对应会话）。"} />}
      {!fetchFailed && !data?.error && !s && id && <BentoState phase="empty" title="未找到该会话" detail="会话服务无记录；可能是历史归档登记。" />}

      {s && (
        <BentoGrid>
          <BentoCard title="消息时间线" sub={(data?.messagesTruncated ? "已截断展示" : "按时间顺序") + " · 共 " + (s.messageCount ?? data?.totalMessages ?? messages.length) + " 条"} span={8}>
            {messages.length ? (
              <ul className={styles.timeline}>
                {messages.map((m) => (
                  <li key={m.messageUid} className={styles.item}>
                    <span className={styles.dot} data-role={m.role} />
                    <div className={styles.itemBody}>
                      <div className={styles.itemHead}><b>{roleLabel(m.role)}</b><span className="mono">{m.createdAt || "n/a"}</span>{m.model ? <span className="mono">{m.model}</span> : null}</div>
                      <div className={styles.text}>{m.content || "(空消息)"}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <div className={styles.stateMini}>该会话在会话服务中暂无消息记录。</div>}
          </BentoCard>

          <BentoCard title="会话信息" span={4}>
            <ul className={styles.kv}>
              <li><span>会话 UID</span><b className="mono">{s.sessionUid}</b></li>
              <li><span>标题</span><b>{s.title || "n/a（接口未下发）"}</b></li>
              <li><span>状态</span><b>{s.status || "n/a（接口未下发）"}</b></li>
              <li><span>负责人</span><b>{s.agentId ? <Link href={"/agents/detail?id=" + encodeURIComponent(s.agentId)} className={styles.link}>{s.agentId}</Link> : "n/a（接口未下发）"}</b></li>
              <li><span>消息数</span><b>{s.messageCount ?? data?.totalMessages ?? "n/a"}</b></li>
              <li><span>最近活动</span><b>{s.lastMessageAt ? fmtTs(s.lastMessageAt) : "n/a（接口未下发）"}</b></li>
              <li><span>关联任务</span><b>n/a（会话详情接口未返回任务关联）</b></li>
            </ul>
            <p className={styles.foot}>返回 <Link href="/sessions" className={styles.link}>会话中心</Link> 保留筛选；本页只读。</p>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}