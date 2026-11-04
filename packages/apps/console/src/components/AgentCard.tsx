import { useRouter } from "next/navigation";

interface Props {
  name: string;
  framework: string;
  terminal: string;
  sessions?: number;
  status: string;
  predecessor?: string;
  avatar?: string;
  dimmed?: boolean;
  agentId?: string;
  lastSeen?: string;
  permissions?: number;
  currentTask?: { id: string; title: string; theme?: string | null; priority?: string | null } | null;
}


// 2026-10-25 R3: emoji 头像退出 chrome —— 数据里带的 emoji 头像一律换成本体首字母
//   （决策 D10：emoji 只允许出现在用户内容里，头像属于界面元素）。文本头像（如 "DS"）保留。
const EMOJI_RE = /[\uD83C-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]|[\uD83C-\uDBFF]/;
function avatarText(avatar?: string, name?: string) {
  const a = (avatar || "").trim();
  if (a && !EMOJI_RE.test(a)) return a;
  return (name || "").trim().slice(0, 1).toUpperCase() || "·";
}

export default function AgentCard({ name, framework, terminal, sessions, status, predecessor, avatar, dimmed, agentId, lastSeen, permissions, currentTask }: Props) {
  const router = useRouter();
  // [UI-S6 / 屏06] 卡片点击进入对象主页 (嵌套页签路由); 权限调整入口在详情页内保留。
  const click = () => { if (agentId) router.push(`/agents/${encodeURIComponent(agentId)}/overview`); };
  return (
    <div className={`agent-card ${dimmed ? "dimmed" : ""}`}
      onClick={click} style={{ cursor: agentId ? "pointer" : "default" }}>
      <div className="agent-avatar">{avatarText(avatar, name)}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "var(--fs-md)", fontWeight: 600 }}>{name}</div>
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
          {framework} · {terminal}
          {sessions !== undefined && ` · 会话 ${sessions.toLocaleString()}`}
          {permissions !== undefined && ` · 权限 ${permissions}`}
          {predecessor && ` · 前任: ${predecessor}`}
        </div>
        {lastSeen && <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)", marginTop: "var(--sp-0-5)" }}>
          最后活跃: {lastSeen}
        </div>}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-1-5)", marginTop: "var(--sp-1)", fontSize: "var(--fs-sm)" }}>
          {currentTask ? (
            <>
              <span className="badge" style={{ background: "var(--primary)", color: "var(--on-primary)", padding: "var(--sp-0-5) var(--sp-2)", borderRadius: "var(--radius-md)" }}>工作中</span>
              <a href={"/flywheel/tasks?focus=" + currentTask.id} onClick={(e) => e.stopPropagation()}
                 style={{ color: "var(--primary)", textDecoration: "underline", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180, display: "inline-block" }}>
                {currentTask.title || currentTask.id.slice(0, 12)}
              </a>
              {currentTask.theme && <span style={{ color: "var(--text-dim)" }}>· {currentTask.theme}</span>}
            </>
          ) : (
            <span style={{ color: "var(--text-dim)" }}>空闲</span>
          )}
        </div>
      </div>
      {/* 2026-10-13 round 76-DG: 原来直接显示**原始枚举值**(ACTIVE/INACTIVE) —— 界面上应说业务话。
          另注意它与左侧的"空闲/工作中"**不是同一维度**: 空闲=当前没有进行中的任务, 这里是启用状态。 */}
      <span className={`badge ${status === "ACTIVE" ? "badge-green" : "badge-yellow"}`}>{status === "ACTIVE" ? "已启用" : "已停用"}</span>
    </div>
  );
}