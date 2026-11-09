"use client";
// 2026-09-10 追加需求: 通用讨论模块
// 任何实体 (task/memory/knowledge/skill/practice/reflection/finding/agent/session) 都能:
//   ① 看到平台自动合成的协作时间线 (发布/流转/提交产出)
//   ② 看到人类与 agent 的讨论发言, 并针对该实体提问
//   ③ @ 某个 agent 提问 → 平台生成可认领任务, agent 回答自动回写本讨论串
// 数据源: console 代理 /api/discussions → mind /api/v1/flywheel/discussions
// 说明: 不做定时轮询 (dev 环境 CPU 敏感), 只提供手动刷新。
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Collapse, Empty, Input, Select, Skeleton, Tag, Timeline, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { ReloadOutlined, SendOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { fmtNum, fmtTime, relTime, truncate } from "@/lib/format";
import { t } from "@/i18n";
import { HUMAN_ID } from "@/lib/todos";
import ConvertToTodoButton from "@/components/ConvertToTodoButton";
// 2026-11-05 P2 批9：内联 style 清零（9 -> 0），全部下沉到同目录 DiscussionPanel.module.css；
//   都是静态间距 / 限宽 / 代码块排版，无动态值，故不引入 data 属性选择器。取数、文案、交互与 props 形状未动。
import styles from "./DiscussionPanel.module.css";

export interface DiscussionPanelProps {
  entityType: string;
  entityId: string;
  title?: string;
}

const KIND_STYLE: Record<string, { color: string; label: string; icon: string }> = {
  publish: { color: "blue", label: "平台发布", icon: "📢" },
  transition: { color: "gray", label: "状态流转", icon: "🔄" },
  submit: { color: "green", label: "提交产出", icon: "📦" },
};

const AUTHOR_STYLE: Record<string, { icon: string; label: string; cls: string }> = {
  human: { icon: "🧑", label: "人类", cls: "human" },
  agent: { icon: "🤖", label: t('common.agent'), cls: "agent" },
  platform: { icon: "🏛", label: "平台", cls: "platform" },
};

const MSG_KIND: Record<string, { color: string; label: string }> = {
  comment: { color: "default", label: "评论" },
  question: { color: "warning", label: "提问" },
  answer: { color: "success", label: "回答" },
};

/** 长文折叠 */
function CollapsibleBody({ text, limit = 420 }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  const body = String(text || "");
  if (body.length <= limit) return <div className="disc-body">{body}</div>;
  return (
    <div>
      <div className="disc-body">{open ? body : truncate(body, limit)}</div>
      <Button type="link" size="small" className={styles.linkBtn} onClick={() => setOpen(!open)}>
        {open ? "收起" : `展开全文（${fmtNum(body.length)} 字）`}
      </Button>
    </div>
  );
}

export default function DiscussionPanel({ entityType, entityId, title }: DiscussionPanelProps) {
  const [data, setData] = useState<any>(null);
  // 2026-10-13 round 76-CZ: 初值**按是否真的会去拉取**来定。
  //   - 有 entityType/entityId -> 挂载即拉取, 首帧就该是"加载中"; 原来初值 false 会先显示"0 个节点"(假计数)。
  //   - 没有 -> 下面的 effect 会**提前 return**, 此时必须**不是** loading, 否则会永久显示"加载中…"。
  const [loading, setLoading] = useState(!!entityType && !!entityId);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [text, setText] = useState("");
  const [askAgentId, setAskAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<{ value: string; label: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  // 拉取讨论串 (仅手动刷新/首次)
  useEffect(() => {
    // 2026-10-13 round 76-CZ: 提前返回时**必须清掉 loading** —— 否则（配合上面的条件初值也）
    //   一旦 entity 变成空, 面板会卡在"加载中…"永远不动。
    if (!entityType || !entityId) { setLoading(false); setData(null); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/discussions?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}&limit=100&_n=${nonce}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(String(e?.message || e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [entityType, entityId, nonce]);

  // agent 列表 (来自既有 /api/agent-list)
  useEffect(() => {
    let alive = true;
    fetch("/api/agent-list", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const list = Array.isArray(d) ? d : (d?.items ?? d?.result?.data ?? []);
        if (!alive || !Array.isArray(list)) return;
        setAgents(
          list
            .filter((a: any) => a?.agent_id)
            .map((a: any) => ({ value: a.agent_id, label: `${a.display_name || a.agent_id} (${a.agent_id})` }))
        );
      })
      .catch(() => { /* agent 列表不可用时仍可发普通评论 */ });
    return () => { alive = false; };
  }, []);

  const rows: any[] = Array.isArray(data?.rows) ? data.rows : [];
  const timeline: any[] = Array.isArray(data?.timeline) ? data.timeline : [];
  const warnings: string[] = Array.isArray(data?.warnings) ? data.warnings : [];

  const send = useCallback(async () => {
    const body = text.trim();
    if (!body) { setFeedback({ type: "err", msg: "请输入内容" }); return; }
    setSending(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/discussions", {
        method: "POST",
        // 2026-09-14: 讨论区发言必须声明"这是真人在 UI 上的操作" —— 否则 mind 记 ACTOR_MISLABELED
        //   且不计入人类干预(用户实测: 讨论区一直显示"自称人类但未声明 x-actor-kind: human")。
        headers: { "Content-Type": "application/json", "x-actor-kind": "human", "x-actor-id": HUMAN_ID },
        body: JSON.stringify({ entityType, entityId, body, authorType: "human", authorId: HUMAN_ID, askAgentId: askAgentId || undefined }),
      });
      const d = await res.json();
      if (d?.ok) {
        setFeedback({
          type: "ok",
          msg: askAgentId
            ? `已发送, 并已向 ${askAgentId} 提问 (平台已生成指派给它的待办, 它回答后会自动回写到本讨论串)`
            : "已发送",
        });
        setText("");
      } else {
        setFeedback({ type: "err", msg: d?.error || "发送失败" });
      }
    } catch (e: any) {
      setFeedback({ type: "err", msg: String(e?.message || e) });
    } finally {
      setSending(false);
      setNonce((n) => n + 1);
    }
  }, [text, askAgentId, entityType, entityId]);

  if (!entityType || !entityId) {
    return (
      <Card className="disc-panel" size="small" title={title || "讨论与协作"}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="缺少实体编号，无法加载讨论（请从列表点进来）" />
      </Card>
    );
  }

  return (
    <Card
      className="disc-panel"
      size="small"
      title={
        <span className="disc-sub">
          <span>{title || "讨论与协作"}</span>
          <Tag color="blue">{entityType}</Tag>
          <span className="tiny mono">{entityId.length > 14 ? entityId.slice(0, 10) + "…" : entityId}</span>
        </span>
      }
      extra={
        <span className="disc-sub">
          {data?.asOf ? <span className="tiny">数据时间 {fmtTime(data.asOf).slice(5)}</span> : null}
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => setNonce((n) => n + 1)}>刷新</Button>
        </span>
      }
    >
      {error ? (
        <Alert type="error" showIcon className={styles.alertMb} title="讨论加载失败" description={error} />
      ) : null}
      {warnings.length ? (
        <Alert type="warning" showIcon className={styles.alertMb} title="上游提示" description={warnings.join("；")} />
      ) : null}

      {/* ---------- 上: 平台协作时间线 ---------- */}
      <div className="disc-section-title">
        平台协作时间线
        <span className="tiny">{loading && !data ? "加载中…" : `${fmtNum(timeline.length)} 个节点`}</span>
      </div>
      {loading && !data ? (
        <Skeleton active paragraph={{ rows: 3 }} title={false} />
      ) : timeline.length === 0 ? (
        <div className={"tiny " + styles.sectionEmpty}>
          该实体没有平台自动时间线（时间线由任务类实体自动合成: 发布 → 认领 → 提交产出 → 状态流转）。
        </div>
      ) : (
        <Timeline
          className="disc-timeline"
          items={timeline.map((t: any, i: number) => {
            const k = KIND_STYLE[t.kind] || { color: "gray", label: t.kind, icon: "•" };
            return {
              key: i,
              color: k.color,
              content: (
                <div>
                  <div className="dt-meta">
                    <Tag color={k.color}>{k.icon} {k.label}</Tag>
                    <span className="actor-chip platform">{t.actor || "platform"}</span>
                    <span className="tiny">{fmtTime(t.at)}</span>
                    <span className="tiny">· {relTime(t.at)}</span>
                  </div>
                  <div className={"dt-text " + styles.textTop}>{t.kind === "submit" ? truncate(t.text, 600) : truncate(t.text, 300)}</div>
                  {t.kind === "submit" && String(t.text || "").length > 600 ? (
                    <Collapse
                      size="small"
                      ghost
                      items={[{ key: "1", label: `查看完整产出（${fmtNum(String(t.text).length)} 字）`, children: <pre className={styles.pre}>{t.text}</pre> }]}
                    />
                  ) : null}
                </div>
              ),
            };
          })}
        />
      )}

      {/* ---------- 下: 讨论发言流 ---------- */}
      <div className={"disc-section-title " + styles.sectionTitleGap}>
        讨论发言
        <span className="tiny">{loading && !data ? "加载中…" : `${fmtNum(data?.count ?? rows.length)} 条`}</span>
      </div>
      {loading && !data ? (
        <Skeleton active paragraph={{ rows: 3 }} title={false} />
      ) : rows.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有讨论, 在下面说出你的第一个问题吧" />
      ) : (
        rows.map((m: any) => {
          const a = AUTHOR_STYLE[m.authorType] || AUTHOR_STYLE.platform;
          const k = MSG_KIND[m.kind] || { color: "default", label: m.kind };
          return (
            <div className="disc-msg" key={m.id}>
              <div className={`disc-avatar ${a.cls}`} title={a.label}>{a.icon}</div>
              <div className="disc-main">
                <div className="disc-meta">
                  <span className="disc-author">{String(m.authorId || a.label).replace(/^human:/, "").replace(/^agent:/, "")}</span>
                  <Tag color={k.color}>{k.label}</Tag>
                  <Tooltip title={fmtTime(m.createdAt)}>
                    <span className="tiny">{relTime(m.createdAt)}</span>
                  </Tooltip>
                  {m.taskId ? (
                    <Tooltip title={t('disc.agentReplyTip')}>
                      <a className="tiny tiny-link" href={`/flywheel/tasks/${m.taskId}`}>关联任务 {String(m.taskId).slice(0, 8)}…</a>
                    </Tooltip>
                  ) : null}
                  {/* 2026-09-10: 任意一条发言都能一键转成人的待办项 */}
                  <ConvertToTodoButton
                    title={String(m.body || "").slice(0, 60) || "讨论跟进"}
                    detail={`来自 ${entityType} ${entityId} 的讨论发言 (${m.authorId || "-"})\n\n${String(m.body || "").slice(0, 1500)}`}
                    source="discussion"
                    sourceRefId={m.id}
                  />
                </div>
                <CollapsibleBody text={m.body} />
              </div>
            </div>
          );
        })
      )}

      {/* ---------- 输入区 ---------- */}
      <div className="disc-composer">
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoSize={{ minRows: 2, maxRows: 6 }}
          placeholder={
            askAgentId
              ? `向 ${askAgentId} 提问…（发送后会生成一条该 agent 可认领的任务, 回答自动回写本讨论串）`
              : "写下你的评论或问题（人类发言会记一次 HUMAN_INTERVENTION, 用于真实自主率统计）…"
          }
          onPressEnter={(e) => {
            if ((e as any).ctrlKey || (e as any).metaKey) { e.preventDefault(); send(); }
          }}
        />
        <div className="disc-actions">
          <Select
            size="small"
            className={styles.agentSelect}
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder={t('disc.askPlaceholder')}
            value={askAgentId ?? undefined}
            onChange={(v) => setAskAgentId(v ?? null)}
            options={agents}
            notFoundContent={t('disc.noAgents')}
          />
          <Button type="primary" size="small" icon={<SendOutlined />} loading={sending} onClick={send} disabled={!text.trim()}>
            发送
          </Button>
          <span className="disc-hint">Ctrl/⌘ + Enter 发送 · 回答会自动回写讨论串</span>
        </div>
        {feedback ? (
          <Alert type={feedback.type === "ok" ? "success" : "error"} showIcon title={feedback.msg} className={styles.alertMb0} />
        ) : null}
        <div className="disc-hint">
          数据源: mind <code>/api/v1/flywheel/discussions</code> (console 代理 <code>/api/discussions</code>) · 不做定时轮询, 需要最新状态请点右上角刷新。
        </div>
      </div>
    </Card>
  );
}
