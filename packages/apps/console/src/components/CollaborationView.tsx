"use client";
// 2026-09-10 增补: 平台协作时间线 (任务式对话)
// 把平台 ↔ Agent 的异步协作按任务线程渲染成"聊天记录":
//   平台发布 → agent 认领(actor) → 提交产出(可展开全文/长度/质量分) → 平台裁定(VERIFIED/REJECTED/PROPOSAL_ACCEPTED/HUMAN_INTERVENTION)
// 外加两个已上线 mind 接口的面板: 近 24h 人类干预 + agent 结论候选三态。
import { useMemo, useState } from "react";
import { Alert, Button, Card, Input, Segmented, Select, Switch, Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { ReloadOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { useApi } from "@/lib/api";
import { t } from "@/i18n";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { MetricCard, PanelCard, Pill, StateBlock } from "@/components/ui";
import { fmtNum, fmtTime, qualityTone, relTime, truncate } from "@/lib/format";
import { scopeDef, scopeOfType } from "@/config/taskScopes";
import ConvertToTodoButton from "@/components/ConvertToTodoButton";

const KIND_STYLE: Record<string, { dot: string; label: string }> = {
  publish: { dot: "var(--primary)", label: "平台发布" },
  claim: { dot: "var(--table-memory)", label: "认领" },
  reply: { dot: "var(--primary)", label: t('collab.agentOutput') },
  verdict: { dot: "var(--status-ok)", label: "平台裁定" },
  human: { dot: "var(--status-warn)", label: "人类介入" },
  candidate: { dot: "var(--table-knowledge)", label: "结论候选" },
  ingest: { dot: "var(--table-knowledge)", label: "产出收下" },
  context: { dot: "var(--text-muted)", label: "上下文注入" },
  "verify-task": { dot: "var(--text-muted)", label: "派发复核" },
  claim2: { dot: "var(--table-memory)", label: "认领" },
  fail: { dot: "var(--status-crit)", label: "失败" },
  retire: { dot: "var(--text-muted)", label: "废弃" },
  state: { dot: "var(--text-muted)", label: "状态变更" },
};

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  DONE: { color: "success", label: "已完成" },
  FAILED: { color: "error", label: "失败" },
  IN_PROGRESS: { color: "processing", label: "进行中" },
  PROCESSING: { color: "processing", label: "处理中" },
  PENDING: { color: "default", label: "待认领" },
  DEPRECATED: { color: "default", label: "已废弃" },
};

const VERIFY_TAG: Record<string, { color: string; label: string }> = {
  PENDING_REVIEW: { color: "warning", label: "待复核" },
  PROPOSAL_ACCEPTED: { color: "processing", label: "提案已接受" },
  VERIFIED: { color: "success", label: "已验证" },
  REJECTED: { color: "error", label: "已驳回" },
};

/** 标题里已带 [GOAL_GAP] 这类前缀时不再重复展示 */
function displayTitle(title: string, label: string): string {
  const t = String(title || "");
  if (!label) return t;
  let out = t;
  const m = /^\[[^\]]+\]\s*/.exec(out);
  if (m) {
    const inner = m[0].slice(1, -1).trim().toLowerCase();
    const lab = label.toLowerCase();
    if (inner && (lab.includes(inner) || inner.includes(lab) || (inner.startsWith("verify") && lab.includes("验证")))) {
      out = out.slice(m[0].length);
    }
  }
  // 去掉紧接着重复出现的类型名 (Tag 已经展示过一次)
  if (out.startsWith(label)) out = out.slice(label.length).replace(/^[:：\s]+/, "");
  return out;
}

function ActorChip({ actor, kind }: { actor: string; kind: string }) {
  const k = ["agent", "human", "platform"].includes(kind) ? kind : "unknown";
  const icon = k === "agent" ? "🤖" : k === "human" ? "🧑" : "🏛";
  return (
    <span className={`actor-chip ${k}`} title={`${k}: ${actor}`}>
      {icon} {actor || k}
    </span>
  );
}

function ThreadEvent({ ev }: { ev: any }) {
  const [open, setOpen] = useState(false);
  const style = KIND_STYLE[ev.kind] || { dot: "var(--text-muted)", label: ev.kind };
  const hasLongOutput = (ev.outputLength || 0) > 220;
  return (
    <div className="thread-event">
      <span className="te-dot" style={{ background: style.dot }} />
      <div className="te-head">
        <span className="te-title" style={{ color: ev.tone === "crit" ? "var(--status-crit)" : undefined }}>{ev.title}</span>
        <ActorChip actor={ev.actor} kind={ev.actorKind} />
        {ev.status ? <Tag color={STATUS_TAG[ev.status]?.color || "default"}>{STATUS_TAG[ev.status]?.label || ev.status}</Tag> : null}
        {ev.qualityPassed !== null && ev.qualityPassed !== undefined ? (
          <Tag color={ev.qualityPassed ? "success" : "error"}>{ev.qualityPassed ? "质量通过" : "质量未过"}</Tag>
        ) : null}
        {typeof ev.quality === "number" ? (
          <span className="tiny" style={{ color: qualityTone(ev.quality).color }}>质量分 {ev.quality.toFixed(2)}</span>
        ) : null}
        {ev.outputLength ? <span className="tiny">正文 {fmtNum(ev.outputLength)} 字</span> : null}
        <span className="te-time">{fmtTime(ev.at)}</span>
      </div>
      {ev.detail && !ev.output ? <div className="te-detail">{String(ev.detail).slice(0, 400)}</div> : null}
      {ev.output ? (
        <div>
          <div className={`te-output ${open ? "expanded" : ""}`}>
            {open ? ev.output : truncate(ev.output, 260)}
            {!open && hasLongOutput ? <span className="te-output-mask" /> : null}
          </div>
          {hasLongOutput ? (
            <Button type="link" size="small" style={{ paddingLeft: 0 }} onClick={() => setOpen(!open)}>
              {open ? "收起" : `展开全文（${fmtNum(ev.outputLength)} 字）`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ThreadCard({ thread }: { thread: any }) {
  const [open, setOpen] = useState(false);
  const events: any[] = thread.events || [];
  // 折叠态也要保证"人类干预 / 平台裁定"始终可见 (这两类是人类最需要看到的结论性动作)
  const critical = events.filter((e) => e.kind === "human" || e.kind === "verdict");
  const shown = open
    ? events
    : Array.from(new Set([...events.slice(0, 4), ...critical])).sort((a, b) => a.at - b.at);
  const hidden = events.length - shown.length;

  return (
    <Card
      className="thread-card"
      size="small"
      title={
        <div>
          <div className="thread-title">
            {(() => {
              const sd = scopeDef(thread.scope || scopeOfType(thread.improvementType));
              return (
                <Tooltip title={sd.desc}>
                  <Tag style={{ marginRight: "var(--sp-2)", color: sd.color, borderColor: "color-mix(in srgb, " + sd.color + " 40%, transparent)", background: "color-mix(in srgb, " + sd.color + " 9%, transparent)" }}>{sd.short}</Tag>
                </Tooltip>
              );
            })()}
            {thread.improvementTypeLabel ? <Tag color="blue" style={{ marginRight: "var(--sp-2)" }}>{thread.improvementTypeLabel}</Tag> : null}
            {truncate(displayTitle(thread.title, thread.improvementTypeLabel), 78)}
          </div>
          <div className="thread-sub">
            <span className="mono">{thread.taskId.slice(0, 10)}…</span>
            {thread.theme ? <span>主题 {thread.theme}</span> : null}
            {thread.priority ? <span>优先级 {thread.priority}</span> : null}
            <span>发布 {relTime(thread.createdAt)}</span>
            <span>· 最近活动 {relTime(thread.lastActivityAt)}</span>
            <span className="thread-participants">
              {(thread.participants || []).map((p: string) => <Pill key={p} tone="info">{p}</Pill>)}
            </span>
          </div>
        </div>
      }
      extra={
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          {thread.counts?.human ? <Pill tone="warn">人类干预 {thread.counts.human}</Pill> : null}
          {thread.counts?.verdicts ? <Pill tone="ok">裁定 {thread.counts.verdicts}</Pill> : null}
          <Tag color={STATUS_TAG[thread.status]?.color || "default"}>{STATUS_TAG[thread.status]?.label || thread.status}</Tag>
        </div>
      }
    >
      <div className="thread-rail">
        {/* 平台发布 */}
        <div className="thread-event">
          <span className="te-dot" style={{ background: "var(--primary)" }} />
          <div className="te-head">
            <span className="te-title">平台发布任务</span>
            <ActorChip actor={thread.auto ? "平台自动派单" : "平台/目标系统"} kind="platform" />
            <span className="te-time">{fmtTime(thread.createdAt)}</span>
          </div>
          <div className="thread-publish" style={{ marginTop: "var(--sp-2)" }}>
            <div><span className="tp-label">要求</span> {thread.publish?.requirements || "-"}</div>
            <div style={{ marginTop: "var(--sp-1)" }}><span className="tp-label">验收标准</span> {thread.publish?.acceptanceCriteria || "-"}</div>
            {open && thread.publish?.description ? (
              <div style={{ marginTop: "var(--sp-2)" }}>
                <span className="tp-label">完整背景</span>
                <div style={{ marginTop: "var(--sp-1)", maxHeight: 260, overflow: "auto" }}>{thread.publish.description}</div>
              </div>
            ) : null}
          </div>
        </div>

        {shown.map((ev: any) => <ThreadEvent key={ev.id} ev={ev} />)}

        {events.length === 0 ? (
          <div className="tiny" style={{ paddingLeft: "var(--sp-1)" }}>{t('collab.noClaim')}</div>
        ) : null}
      </div>

      {events.length > 4 || (open && thread.publish?.description) ? (
        <div style={{ marginTop: "var(--sp-2)", textAlign: "center" }}>
          <Button type="link" size="small" onClick={() => setOpen(!open)}>
            {open ? "收起线程" : `展开完整线程（还有 ${Math.max(hidden, 0)} 条事件与完整背景）`}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** 右侧: 人类干预 (mind /api/v1/flywheel/interventions; **跟随顶栏时间范围**, 未选时近 24h) */
function InterventionsPanel() {
  // 2026-10-13 round 76-DD: 接入顶栏时间范围 —— 原来这个面板**硬编码近 24h**, 与页面的 range 标签自相矛盾。
  const f = useGlobalFilter();
  const { data, loading, mutate } = useApi<any>("/api/interventions?range=" + f.range + "&_n=" + f.nonce);
  const kindLabel: Record<string, string> = {
    discussion: "讨论区人类发言",
    "knowledge-review": "人类复核知识",
    todo: "人工操作待办",            // 2026-09-10: 待办状态变更 (mind 记 HUMAN_INTERVENTION)
    "todo-update": "待办状态变更",
    human_message: "人类消息",
    task_reassign: "人工改派任务",
    finding_release: "人工放行发现",
    manual_trigger: "人工触发",
    agent_approval: "人工审批 Agent",
    manual_execute: "人工执行",
    other: "其他",
  };
  return (
    <PanelCard
      title="近 24h 人类干预"
      tone="var(--status-warn)"
      extra={
        <Tooltip
          title={
            data?.source === "local-readonly-fallback"
              ? "mind 接口当前不可达, 已降级为本地只读查询 (数据仍真实, 但少了上游的聚合口径)"
              : "来自 mind GET /api/v1/flywheel/interventions"
          }
        >
          <span className="tiny" style={{ color: data?.source === "local-readonly-fallback" ? "var(--status-warn)" : "var(--status-ok)" }}>
            {loading && !data ? "加载中…" : data?.source === "local-readonly-fallback" ? "⚠ 上游不可达·本地兜底" : "🟢 mind 接口"}
          </span>
        </Tooltip>
      }
    >
      {loading && !data ? <StateBlock loading rows={3} /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)" }}>
            <span className="mono" style={{ fontSize: "var(--fs-2xl)", fontWeight: 600, color: "var(--status-warn)" }}>{fmtNum(data?.total)}</span>
            <span className="tiny">次人类干预 · 用于计算"真实自主率"</span>
          </div>
          {(data?.byKind ?? []).length === 0 ? (
            <div className="tiny">近 {data?.windowHours || 24} 小时没有人类干预记录（平台全自动运行）。</div>
          ) : (
            (data?.byKind ?? []).map((k: any) => (
              <div key={k.kind} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--fs-base)" }}>
                <Pill tone="warn">{kindLabel[k.kind] || k.kind}</Pill>
                <span className="mono" style={{ marginLeft: "auto" }}>{fmtNum(k.count)}</span>
              </div>
            ))
          )}
          {(data?.recent ?? []).length ? (
            <div style={{ marginTop: "var(--sp-1)" }}>
              <div className="tiny" style={{ marginBottom: "var(--sp-1)" }}>干预明细</div>
              {(data.recent ?? []).slice(0, 6).map((r: any) => (
                <div key={r.id} className="cand-row">
                  <div className="cr-title">{truncate(r.title, 70)}</div>
                  <div className="cr-meta">
                    <span>{kindLabel[r.kind] || r.kind}</span>
                    <span className="mono">{r.refId ? String(r.refId).slice(0, 10) + "…" : "-"}</span>
                    <span>{relTime(r.at)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <Button size="small" icon={<ReloadOutlined />} onClick={mutate}>刷新</Button>
        </div>
      )}
    </PanelCard>
  );
}

/** 右侧: agent 结论候选三态 (mind /api/v1/flywheel/knowledge-candidates) */
function CandidatesPanel() {
  // 2026-10-13 round 76-DD: 同上 —— 候选列表也按顶栏时间范围过滤。
  const f = useGlobalFilter();
  const [status, setStatus] = useState<string>("ALL");
  const { data, loading, mutate } = useApi<any>(`/api/knowledge-candidates?limit=20&status=${status}&range=${f.range}&_n=${f.nonce}`);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <PanelCard
      title={t('collab.conclusionCandidate')}
      tone="var(--status-ok)"
      extra={
        <Tooltip
          title={
            data?.source === "local-readonly-fallback"
              ? "mind 接口当前不可达, 已降级为本地只读查询 (数据仍真实, 但少了上游的聚合口径)"
              : "来自 mind GET /api/v1/flywheel/knowledge-candidates?limit=20"
          }
        >
          <span className="tiny" style={{ color: data?.source === "local-readonly-fallback" ? "var(--status-warn)" : "var(--status-ok)" }}>
            {loading && !data ? "加载中…" : data?.source === "local-readonly-fallback" ? "⚠ 上游不可达·本地兜底" : "🟢 mind 接口"}
          </span>
        </Tooltip>
      }
    >
      {loading && !data ? <StateBlock loading rows={3} /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap" }}>
            <span className="tiny">待复核 <b className="mono" style={{ color: "var(--status-warn)" }}>{fmtNum(data?.pending)}</b></span>
            <span className="tiny">已验证 <b className="mono" style={{ color: "var(--status-ok)" }}>{fmtNum(data?.verified)}</b></span>
            <span className="tiny">已驳回 <b className="mono" style={{ color: "var(--status-crit)" }}>{fmtNum(data?.rejected)}</b></span>
          </div>
          <Segmented
            size="small"
            value={status}
            onChange={(v) => setStatus(String(v))}
            options={[
              { label: "全部", value: "ALL" },
              { label: "待复核", value: "PENDING_REVIEW" },
              { label: "已验证", value: "VERIFIED" },
              { label: "已驳回", value: "REJECTED" },
            ]}
          />
          {(data?.rows ?? []).length === 0 ? (
            <StateBlock title="该状态下没有候选" rows={2} />
          ) : (
            (data.rows ?? []).map((r: any) => (
              <div key={r.id} className="cand-row">
                <div className="cr-title">{truncate(r.title, 76)}</div>
                <div className="cr-meta">
                  <Tag color={VERIFY_TAG[r.verification]?.color || "default"}>{VERIFY_TAG[r.verification]?.label || r.verification || "未验证"}</Tag>
                  <span>{String(r.agentSource || "").replace(/^agent:/, "") || t('common.unknownAgent')}</span>
                  <span style={{ color: qualityTone(r.qualityScore).color }}>质量分 {r.qualityScore ? Number(r.qualityScore).toFixed(2) : "-"}</span>
                  {r.stale ? <span style={{ color: "var(--status-crit)" }}>已过期</span> : null}
                  <span>{relTime(r.createdAt)}</span>
                </div>
                <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }}>
                  <Button type="link" size="small" style={{ paddingLeft: 0 }} onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                    {openId === r.id ? "收起结论" : "查看结论全文"}
                  </Button>
                  {/* 2026-09-10: 被驳回的 agent 结论 → 一键转成人的待办 (复核/整改) */}
                  {String(r.verification || "").toUpperCase() === "REJECTED" || r.stale ? (
                    <ConvertToTodoButton
                      title={`复核被驳回的智能体结论: ${String(r.title || "").slice(0, 50)}`}
                      detail={`知识候选被驳回 (验证状态=${r.verification || "-"}${r.staleReason ? ", 原因: " + r.staleReason : ""})\n\n${String(r.content || "").slice(0, 1200)}`}
                      source="verification"
                      sourceRefId={r.id}
                      priority="P1"
                      label="转成待办(复核)"
                    />
                  ) : null}
                </div>
                {openId === r.id ? <div className="cand-content">{r.content || "(无正文)"}</div> : null}
              </div>
            ))
          )}
          <Button size="small" icon={<ReloadOutlined />} onClick={mutate}>刷新</Button>
        </div>
      )}
    </PanelCard>
  );
}

export default function CollaborationView() {
  const f = useGlobalFilter();
  const [type, setType] = useState<string>("ALL");
  const [bridge, setBridge] = useState(false);
  const [kw, setKw] = useState("");
  const [kwApplied, setKwApplied] = useState("");
  const [limit, setLimit] = useState(20);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set("range", f.range);
    if (f.agent) p.set("agent", f.agent);
    p.set("type", type);
    if (bridge) p.set("bridge", "1");
    if (kwApplied) p.set("q", kwApplied);
    p.set("limit", String(limit));
    p.set("_n", String(f.nonce));
    return p.toString();
  }, [f.range, f.agent, f.nonce, type, bridge, kwApplied, limit]);

  const { data, loading, mutate } = useApi<any>("/api/collaboration?" + params);
  const s = data?.summary ?? {};
  const threads = data?.threads ?? [];
  const loadingAll = loading && !data;

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: "var(--sp-3)" }}
        title="这是什么"
        description={t('collab.desc')}
      />

      <div className="metric-row">
        <MetricCard
          label="协作线程"
          tone="info"
          value={loadingAll ? "…" : fmtNum(s.threads)}
          unit="条"
          hint={`其中人类可读协作 ${fmtNum(s.humanThreads)} 条`}
          footer={
            s.byScope ? (
              <span className="tiny">
                机制修复 {fmtNum(s.byScope.MECHANISM)} · 验证 {fmtNum(s.byScope.VERIFY)} · 对话 {fmtNum(s.byScope.DISCUSSION)} · 其他 {fmtNum(s.byScope.OTHER)}
              </span>
            ) : null
          }
        />
        <MetricCard label={t('collab.replied')} tone="ok" value={loadingAll ? "…" : fmtNum(s.replied)} unit="条" hint={`共 ${fmtNum(s.replies)} 次提交`} />
        <MetricCard label="平台裁定" tone="ok" value={loadingAll ? "…" : fmtNum(s.verdicts)} unit="次" hint="验证/接受/驳回/缺依据" />
        <MetricCard label="人类干预" tone={s.humanInterventions ? "warn" : "mute"} value={loadingAll ? "…" : fmtNum(s.humanInterventions)} unit="次" hint="人否决/复核/发言" />
        <MetricCard label={t('collab.participants')} tone="info" value={loadingAll ? "…" : fmtNum((s.participants ?? []).length)} unit="个" hint={(s.participants ?? []).slice(0, 2).map((p: any) => p.agentId).join("、")} />
        <MetricCard label="平均回复长度" tone="mute" value={loadingAll ? "…" : fmtNum(s.avgReplyLength)} unit="字" hint={`质量通过 ${fmtNum(s.replyQualityPassed)} / ${fmtNum(s.replies)}`} />
      </div>

      <div className="card-grid main-side">
        <div>
          <div className="collab-toolbar">
            <span className="ct-label">任务类型</span>
            <Select
              size="small"
              style={{ minWidth: 168 }}
              value={type}
              onChange={setType}
              options={(data?.types ?? [{ value: "ALL", label: "全部类型", count: 0 }]).map((t: any) => ({
                value: t.value,
                label: `${t.label}${t.count ? " · " + fmtNum(t.count) : ""}`,
              }))}
            />
            <Switch size="small" checked={bridge} onChange={setBridge} />
            <span className="ct-label">含自动桥接任务(BRIDGE)</span>
            <Input.Search
              size="small"
              allowClear
              placeholder="搜索任务标题 / 主题"
              style={{ width: 220 }}
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              onSearch={(v) => setKwApplied(v)}
            />
            <span className="ct-label">条数</span>
            <Select
              size="small"
              style={{ width: 88 }}
              value={limit}
              onChange={setLimit}
              options={[10, 20, 40, 60].map((n) => ({ value: n, label: n + " 条" }))}
            />
            <Button size="small" icon={<ReloadOutlined />} onClick={mutate}>刷新</Button>
            {f.agent ? <Pill tone="info">智能体：{f.agent}</Pill> : null}
            <Pill tone="mute">{data?.range?.label || f.range}</Pill>
          </div>

          {data?.warnings?.length ? (
            <Alert type="warning" showIcon style={{ marginBottom: "var(--sp-3)" }} title="数据源提示" description={data.warnings.join("；")} />
          ) : null}

          {loadingAll ? (
            <Card className="thread-card" size="small"><StateBlock loading rows={4} /></Card>
          ) : threads.length === 0 ? (
            <PanelCard title="协作线程">
              <StateBlock
                title="当前筛选下没有协作线程"
                desc={t('collab.emptyHint')}
              />
            </PanelCard>
          ) : (
            threads.map((t: any) => <ThreadCard key={t.taskId} thread={t} />)
          )}
        </div>

        <div className="collab-side">
          <InterventionsPanel />
          <CandidatesPanel />
          <PanelCard title="平台裁定分布" tone="var(--status-ok)" extra={<span className="tiny">{data?.range?.label}</span>}>
            {(s.verdictBreakdown ?? []).length === 0 ? (
              <StateBlock title="窗口内没有裁定事件" rows={2} />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", fontSize: "var(--fs-base)" }}>
                {(s.verdictBreakdown ?? []).map((v: any) => (
                  <div key={v.stage} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
                    <Pill tone={v.stage === "KNOWLEDGE_REJECTED" ? "crit" : v.stage === "HUMAN_INTERVENTION" ? "warn" : "ok"}>
                      {v.label}
                    </Pill>
                    <span className="mono" style={{ marginLeft: "auto" }}>{fmtNum(v.count)}</span>
                  </div>
                ))}
                <div className="tiny" style={{ marginTop: "var(--sp-1)", lineHeight: 1.7 }}>
                  {t('collab.verdictNote')}
                </div>
              </div>
            )}
          </PanelCard>
          <PanelCard title={t('collab.participation')} extra={<span className="tiny">按线程数</span>}>
            {(s.participants ?? []).length === 0 ? (
              <StateBlock title={t('collab.noParticipation')} rows={2} />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
                {(s.participants ?? []).map((p: any) => {
                  const max = (s.participants ?? [])[0]?.threads || 1;
                  return (
                    <div key={p.agentId} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--fs-sm)" }}>
                      <span className="truncate" style={{ width: 120 }}>{p.agentId}</span>
                      <div className="mini-bar" style={{ flex: 1 }}>
                        <div className="mini-bar-fill" style={{ width: `${(p.threads / max) * 100}%`, background: "var(--primary)" }} />
                      </div>
                      <span className="mono nowrap">{fmtNum(p.threads)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </PanelCard>
        </div>
      </div>

      <div className="tiny" style={{ textAlign: "right" }}>
        {t('collab.source')}{" "}
        {data?.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "-"}
      </div>
    </div>
  );
}
