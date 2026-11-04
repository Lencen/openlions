"use client";
// Phase0.5 (2026-09-17): 会话中心表格 —— 独立 client 块仅为拿到整行点击 (useRouter)。
// 服务端 page.tsx 传入 items, 本组件照常 SSR, curl 拉到的 HTML 仍含会话行。
import Link from "next/link";
import { useRouter } from "next/navigation";
import TableCopyButton from "@/components/TableCopyButton";

export interface SessionItem {
  session_uid: string;
  agent_id: string;
  source: string | null;
  title: string | null;
  message_count: number;
  status: string;
  updated_at?: string | null;
  uploaded_at?: string | null;
}

// 2026-10-26：状态与来源一律业务化 —— 原实现把 PROCESSED/PENDING/FAILED/SKIPPED 这类
//   英文枚举直接印在界面上（且 SKIPPED 落到兜底蓝色、没有中文），违反「界面不出现裸状态值」。
//   现在：状态 → 中文 + 色点（色点只表状态），来源 → 中文标签。
const STATUS: Record<string, { text: string; state: "ok" | "warn" | "crit" | "idle" }> = {
  // 2026-10-26：活库的状态键是 DONE（stats 换源后已确认），这里原来只有 PROCESSED →
  //   9,899 行 DONE 会渲染成裸英文 "DONE" + 灰点，正好违反「界面不出现裸状态值」。
  //   两个键都保留：死库快照/历史数据仍可能是 PROCESSED。
  DONE: { text: "已提炼", state: "ok" },
  PROCESSED: { text: "已提炼", state: "ok" },
  PENDING: { text: "待提炼", state: "warn" },
  FAILED: { text: "提炼失败", state: "crit" },
  SKIPPED: { text: "已跳过", state: "idle" },
  RUNNING: { text: "进行中", state: "warn" },
};
const SOURCE_LABEL: Record<string, string> = {
  HERMES_SESSION: "Hermes 会话",
  OPENCLAW_SESSION: "OpenClaw 会话",
  CLAUDE_SESSION: "Claude 会话",
  CLAUDE_CODE: "Claude Code",
  MANUAL: "手工录入",
  SESSION_EXTRACT: "会话提炼",
};
function statusOf(status: string) {
  return STATUS[String(status || "").toUpperCase()] || { text: String(status || "未知"), state: "idle" as const };
}
function sourceOf(source?: string | null) {
  if (!source) return "—";
  return SOURCE_LABEL[source] || source;
}

export default function SessionsTable({ items }: { items: SessionItem[] }) {
  const router = useRouter();
  return (
    <>
        <TableCopyButton />
        <table className="tbl">
      <thead>
        <tr>
          <th>会话 UID</th><th>智能体</th><th>来源</th><th>标题</th>
          <th>消息</th><th>状态</th><th>更新时间</th>
        </tr>
      </thead>
      <tbody>
        {items.map((s, i) => {
          const href = `/sessions/detail?id=${encodeURIComponent(s.session_uid)}`;
          return (
            <tr
              key={i}
              onClick={() => router.push(href)}
              style={{ cursor: "pointer" }}
              title="点击查看会话详情"
            >
              <td className="mono" style={{ fontSize: "var(--fs-sm)", maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <Link href={href} style={{ color: "var(--text)" }}>{s.session_uid || "-"}</Link>
              </td>
              <td>{s.agent_id}</td>
              <td>{sourceOf(s.source)}</td>
              <td style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <Link href={href} style={{ color: "var(--text)" }}>{s.title ?? "-"}</Link>
              </td>
              <td className="num">{s.message_count}</td>
              <td>
                {(() => { const st = statusOf(s.status); return (
                  <span className="dt-chip" data-state={st.state}><i />{st.text}</span>
                ); })()}
              </td>
              <td className="mono" style={{ fontSize: "var(--fs-sm)" }}>{(s.updated_at ?? s.uploaded_at ?? "").slice(0, 10)}</td>
            </tr>
          );
        })}
        {items.length === 0 && (
          <tr><td colSpan={7} style={{ padding: "var(--sp-4)", color: "var(--text-dim)", textAlign: "center" }}>暂无会话数据</td></tr>
        )}
      </tbody>
    </table>
        </>
  );
}
