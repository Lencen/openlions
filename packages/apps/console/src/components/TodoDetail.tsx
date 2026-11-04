"use client";
// 2026-09-11 用户反馈: 待办中心只有标题和一段裸文本, 人类看不到上下文。
// 规范: docs/platform-logic/todo.md —— detail 七段结构 + meta 机器可读字段 + 渲染要求。
// 本组件负责按规范渲染 (段标题加粗 / 动作清单有序列表 / URL 可点 / meta.taskIds 跳任务 / options 选项卡片 / 旧格式标记)。
import { useCallback, useEffect, useState } from "react";
import { Button, Skeleton, Tag, Timeline, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { ReloadOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import type { ReactNode } from "react";
import { Pill, StateBlock } from "@/components/ui";
import DiscussionPanel from "@/components/DiscussionPanel";
import { fmtNum, relTime } from "@/lib/format";
import { t } from "@/i18n";
import { patchTodo } from "@/lib/todos";

/** 七段标题 → 机器 key (与 docs/platform-logic/todo.md 的 sections 一致) */
export const SECTION_KEYS: Record<string, string> = {
  "背景": "background",
  "要做什么": "actions",
  "验收标准": "acceptance",
  "上下文与证据": "context",
  "影响与代价": "impact",
  "决策项": "decision",
  "时限": "due",
};

export interface TodoSection {
  key: string;
  title: string;
  body: string;
  items: string[]; // 有序列表条目 (无编号则为空)
}

export interface TodoOption {
  key: string;
  label: string;
  impact?: string | null;
}

export interface ParsedDetail {
  structured: boolean;
  sections: TodoSection[];
  raw: string;
}

const NUMBERED = /^\s*(?:\d+)[.、)]\s*/;

function splitItems(body: string): { items: string[]; rest: string } {
  const lines = body.split("\n");
  const numbered = lines.filter((l) => NUMBERED.test(l));
  // 大部分行都是编号行 → 视为动作清单
  if (numbered.length >= 2 && numbered.length >= lines.filter((l) => l.trim()).length - 1) {
    return { items: numbered.map((l) => l.replace(NUMBERED, "").trim()), rest: "" };
  }
  return { items: [], rest: body };
}

/** 段标题别名 (兼容生成方的不同写法) */
const TITLE_ALIAS: Record<string, string> = {
  "背景": "background",
  "要做什么": "actions",
  "怎么做": "actions",
  "验收标准": "acceptance",
  "验收": "acceptance",
  "上下文与证据": "context",
  "上下文": "context",
  "证据": "context",
  "影响与代价": "impact",
  "影响": "impact",
  "决策项": "decision",
  "决策选项": "decision",
  "时限": "due",
  "截止": "due",
};

/** 规范顺序: 决策项优先(可复算/需人决策), 其余按七段原序 */
export const SECTION_ORDER = ["decision", "background", "actions", "acceptance", "context", "impact", "due"];

export function sectionKeyOf(title: string): string {
  const t = String(title || "").trim().replace(/^#+\s*/, "").replace(/【|】/g, "").trim();
  return TITLE_ALIAS[t] || SECTION_KEYS[t] || t;
}

/**
 * 解析 detail 分段, 兼容两种写法 (2026-09-11):
 *   ① markdown:  ## 背景 / ## 要做什么 ...       (generate 脚本与 agent 现在用这种)
 *   ② 方括号:    【背景】 / 【要做什么】 ...
 * 都不匹配 → structured=false (旧格式), 但仍完整返回 raw 供原样展示。
 * ③ 圈号: ①背景 / ②要您决定什么 ... (人类决策卡/落地卡生成方 human-decision-consumer 从 09-15 起用, 2026-09-21 补解析)
 */
// 2026-09-21 修(实测: 决策卡 todo_o0dnk6afkr78ho3u 只解析出【技术细节】): 圈号分节的 ①-⑤ 被当
//   "无标题的正文行"整段丢掉 —— 决策问题/背景/选项 A/B/C/推荐 一概不显示, 选项卡片不渲染。
//   修: 解析前把圈号分节归一化为 ## 标题; ②要您决定什么 / ③选项 / ④推荐 合并成一个 ## 决策项
//   段(选项与推荐同段, parseOptionsFromText 才能取出 A/B/C 与推荐)。
const CIRCLED_MAP: Record<string, { title: string; decision?: boolean }> = {
  "①": { title: "背景" },
  "②": { title: "决策项", decision: true },
  "③": { title: "决策项", decision: true },
  "④": { title: "决策项", decision: true },
  "⑤": { title: "影响与代价" },
  "⑥": { title: "时限" },
  "⑦": { title: "背景" },
  "⑧": { title: "背景" },
  "⑨": { title: "背景" },
  "⑩": { title: "背景" },
};
function normalizeCircled(trimmed: string): string {
  if (!/^[①-⑩]/m.test(trimmed) && !/\n\s*[①-⑩]/.test(trimmed)) return trimmed;
  const lines = trimmed.split("\n");
  const out: string[] = [];
  let decisionOpen = false;
  for (const line of lines) {
    const t = line.trim();
    const m = /^([①-⑩])\s*(.*)$/.exec(t);
    if (!m) { out.push(line); continue; }
    const num = m[1];
    const rest = m[2];
    const map = CIRCLED_MAP[num];
    if (map?.decision) {
      if (!decisionOpen) { out.push("## 决策项"); decisionOpen = true; }
      // 只剥"要您决定什么/选项与各自后果"这类段内标签; 保留"推荐/建议"字样(parseOptionsFromText 靠它识别推荐项)
      if (rest) out.push(rest.replace(/^(?:要您决定什么|选项与各自后果|选项)\s*[:：]?\s*/i, ""));
    } else {
      decisionOpen = false;
      out.push("## " + (map?.title || rest || "段落"));
      if (rest) out.push(rest.replace(/^.{0,20}?[:：]\s*/, ""));
    }
  }
  return out.join("\n");
}
export function parseDetail(detail?: string | null): ParsedDetail {
  const raw = String(detail || "");
  const trimmed = normalizeCircled(raw.trim());
  const hasBracket = /【[^】]+】/.test(trimmed);
  const hasHeading = /^\s*#{1,2}\s+\S/m.test(trimmed);
  if (!hasBracket && !hasHeading) {
    return { structured: false, sections: [], raw };
  }
  const parts: { title: string; body: string[] }[] = [];
  let cur: { title: string; body: string[] } | null = null;
  for (const line of trimmed.split("\n")) {
    // 只把 # / ## 当作"段"; ### 及更深当作段内小标题 (保留在正文里, 渲染时加粗)
    const head = /^\s*#{1,2}\s+(.+?)\s*$/.exec(line);
    const br = /^\s*【([^】]+)】\s*(.*)$/.exec(line);
    if (head && head[1] && !/^【/.test(head[1])) {
      cur = { title: head[1], body: [] };
      parts.push(cur);
      continue;
    }
    if (br) {
      cur = { title: br[1], body: br[2] ? [br[2]] : [] };
      parts.push(cur);
      continue;
    }
    if (cur) cur.body.push(line);
  }
  const sections: TodoSection[] = parts
    .map((p) => {
      const body = p.body.join("\n").trim();
      const { items } = splitItems(body);
      return { key: sectionKeyOf(p.title), title: p.title.replace(/^#+\s*/, "").replace(/【|】/g, ""), body, items };
    })
    .filter((s) => s.title || s.body);
  return { structured: sections.length > 0, sections, raw };
}

/** 从【决策项】文本里兜底解析 A) B) C) 选项 (meta.options 缺失时) */
export function parseOptionsFromText(text: string): { options: TodoOption[]; recommended: string | null } {
  if (!text) return { options: [], recommended: null };
  const recommendedMatch = /(?:推荐|建议)\s*[:：]?\s*(?:按(?:选项|方案)\s*)?([A-D])/.exec(text);
  const recommended = recommendedMatch ? recommendedMatch[1] : null;
  const parts = text.split(/(?=(?:^|\s)[A-D][).、])/).map((s) => s.trim()).filter(Boolean);
  const options: TodoOption[] = [];
  for (const p of parts) {
    const mm = /^([A-D])[).、]\s*([\s\S]*)$/.exec(p);
    if (!mm) continue;
    let label = mm[2].trim();
    let impact: string | null = null;
    // "A) 做法 —— 影响" / "A) 做法; 代价: xxx" 两种写法都尽量拆出影响
    const sep = /\s*(?:——|--|;|；|\|)\s*/.exec(label);
    if (sep) {
      impact = label.slice(sep.index + sep[0].length).trim();
      label = label.slice(0, sep.index).trim();
    }
    label = label.replace(/[。;；]\s*$/, "");
    options.push({ key: mm[1], label: label || `选项 ${mm[1]}`, impact });
  }
  return { options, recommended };
}

const URL_RE = /(https?:\/\/[^\s，。；、）)]+)/g;
const ID_RE = /\b(c[a-z0-9]{20,})\b/g;

/** 文本渲染: URL 与任务 id 都可点 */
function RichText({ text }: { text: string }): ReactNode {
  const parts: ReactNode[] = [];
  let key = 0;
  const tokens: { type: "text" | "url" | "id"; v: string }[] = [];
  let rest = text;
  // 先按 URL 切, 再在文本片段里找 id
  let last = 0;
  const urlMatches: { start: number; end: number; v: string }[] = [];
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(rest))) urlMatches.push({ start: m.index, end: m.index + m[0].length, v: m[0] });
  for (const um of urlMatches) {
    if (um.start > last) tokens.push({ type: "text", v: rest.slice(last, um.start) });
    tokens.push({ type: "url", v: um.v });
    last = um.end;
  }
  if (last < rest.length) tokens.push({ type: "text", v: rest.slice(last) });

  for (const tk of tokens) {
    if (tk.type === "url") {
      parts.push(
        <a key={key++} href={tk.v} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all" }}>{tk.v}</a>
      );
      continue;
    }
    ID_RE.lastIndex = 0;
    let li = 0;
    let im: RegExpExecArray | null;
    while ((im = ID_RE.exec(tk.v))) {
      if (im.index > li) parts.push(<span key={key++}>{tk.v.slice(li, im.index)}</span>);
      const id = im[1];
      parts.push(
        <a key={key++} href={`/flywheel/tasks/${id}`} title={`打开任务 ${id}`} style={{ fontFamily: "var(--font-mono)", fontSize: "0.94em" }}>
          {id}
        </a>
      );
      li = im.index + im[0].length;
    }
    if (li < tk.v.length) parts.push(<span key={key++}>{tk.v.slice(li)}</span>);
  }
  return <>{parts}</>;
}

const TASK_STATUS_TAG: Record<string, { color: string; label: string }> = {
  DONE: { color: "success", label: "已完成" },
  FAILED: { color: "error", label: "失败" },
  IN_PROGRESS: { color: "processing", label: "进行中" },
  PROCESSING: { color: "processing", label: "处理中" },
  PENDING: { color: "default", label: "待认领" },
  DEPRECATED: { color: "default", label: "已废弃" },
};
const PRIORITY_COLOR: Record<string, string> = { P0: "var(--status-crit)", P1: "var(--status-warn)", P2: "var(--text-muted)" };

/** 段正文: ### 小标题加粗, 其余行用 RichText (URL/任务 id 可点) */
function SectionBody({ body }: { body: string }) {
  const lines = String(body || "").split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const sub = /^\s*#{3,6}\s+(.+?)\s*$/.exec(line);
        if (sub) {
          return (
            <div key={i} style={{ fontWeight: 600, color: "var(--text-dim)", margin: "var(--sp-1-5) 0 var(--sp-0-5)" }}>
              {sub[1]}
            </div>
          );
        }
        return (
          <div key={i} style={{ whiteSpace: "pre-wrap" }}>
            <RichText text={line} />
          </div>
        );
      })}
    </>
  );
}

export default function TodoDetail({ todo, onDecide }: { todo: any; onDecide?: (row: any, option?: { key: string; label: string }) => void }) {
  // 2026-09-21: 选项卡片可点击 —— 人类待办点击选项 = 预填"提交我的决定"弹窗(由页面 onDecide 接线)
  const pickOption = (o: TodoOption) => {
    if (!onDecide) return;
    onDecide(todo, { key: o.key, label: String(o.label || "") });
  };
  // 2026-09-11: 对齐任务详情页 —— 关联任务卡片 / 处理时间线 / 来源回溯 / 讨论面板
  const [extra, setExtra] = useState<any>(null);
  const [extraLoading, setExtraLoading] = useState(false);
  const [extraError, setExtraError] = useState<string | null>(null);
  const loadExtra = useCallback(() => {
    if (!todo?.id) return;
    setExtraLoading(true);
    setExtraError(null);
    fetch(`/api/todo-detail?id=${encodeURIComponent(todo.id)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setExtra(d))
      .catch((e) => setExtraError(String(e?.message || e)))
      .finally(() => setExtraLoading(false));
  }, [todo?.id]);
  useEffect(() => { loadExtra(); }, [loadExtra]);

  // meta 支持本地更新 (mind PATCH 现在接受 meta: 给历史待办补机器可读字段)
  const initialMeta = (() => {
    if (!todo?.meta) return null;
    if (typeof todo.meta === "object") return todo.meta;
    try { return JSON.parse(todo.meta); } catch { return null; }
  })();
  const [localMeta, setLocalMeta] = useState<any>(initialMeta);
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaMsg, setMetaMsg] = useState<string | null>(null);
  useEffect(() => { setLocalMeta(initialMeta); }, [todo?.id]);
  const meta = localMeta;
  const parsed = parseDetail(todo?.detail);
  const taskIds: string[] = Array.isArray(meta?.taskIds) ? meta.taskIds : [];
  const metaLinks: { label: string; url: string }[] = Array.isArray(meta?.links) ? meta.links : [];
  const decisionSection = parsed.sections.find((s) => s.key === "decision");
  const textOptions = parseOptionsFromText(decisionSection?.body || "");
  const options: TodoOption[] = Array.isArray(meta?.options) && meta.options.length
    ? meta.options.map((o: any) => ({ key: String(o.key ?? o.id ?? "-"), label: String(o.label ?? ""), impact: o.impact ?? null }))
    : textOptions.options;
  const recommendedKey = meta?.recommended ? String(meta.recommended) : textOptions.recommended;

  // ---- 负责人 / 状态 + 最近一次状态变更 (2026-09-11 评审采纳: 这三个字段必须在详情里显式可见) ----
  const ownerLabel = todo?.ownerType === "human"
    ? `🧑 人类${todo?.ownerId ? " · " + todo.ownerId : t('todo.owner.humanNone')}`
    : todo?.ownerType === "agent"
      ? `🤖 ${t('common.agent')}${todo?.ownerId ? " · " + todo.ownerId : t('todo.owner.agentNone')}`
      : String(todo?.ownerType || "未指定");
  const timeline: any[] = Array.isArray(extra?.timeline) ? extra.timeline : [];
  const statusEvents = timeline.filter((t) => t.kind === "status");
  const lastStatusEvent = statusEvents.length ? statusEvents[statusEvents.length - 1] : null;
  const lastChangeAt = lastStatusEvent ? lastStatusEvent.at : (todo?.updatedAt || todo?.createdAt || null);
  const statusMeta: Record<string, { label: string; tone: string }> = {
    OPEN: { label: "待办", tone: "info" },
    DOING: { label: "进行中", tone: "warn" },
    BLOCKED: { label: "受阻", tone: "crit" },
    DONE: { label: "已完成", tone: "ok" },
    DROPPED: { label: "已放弃", tone: "mute" },
  };
  // ---- 依赖与阻塞: meta.blockedBy + 关联任务里未完成的阻塞项 ----
  const blockedBy: string[] = Array.isArray(meta?.blockedBy)
    ? meta.blockedBy.map(String)
    : meta?.blockedBy ? [String(meta.blockedBy)] : [];
  const relatedTasks: any[] = Array.isArray(extra?.relatedTasks) ? extra.relatedTasks : [];
  const openBlockers = relatedTasks.filter((t) => !["DONE", "DEPRECATED"].includes(String(t.status)));
  const hasBlocking = blockedBy.length > 0 || openBlockers.length > 0;
  // ---- meta 机器字段 (核验统计等): 已知标量键渲染成小卡片 ----
  const META_STAT_KEYS = ["resolvedTotal", "specific", "notFound", "tooGeneric", "noAssertion", "marker"];
  const metaStats = META_STAT_KEYS.filter((k) => meta && meta[k] !== undefined && meta[k] !== null).map((k) => ({ k, v: meta[k] }));
  const metaScalars = Object.entries(meta || {}).filter(
    ([k, v]) => !["sections", "taskIds", "options", "links", "generatedBy", "recommended", "blockedBy"].includes(k)
      && !META_STAT_KEYS.includes(k)
      && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
  ) as [string, any][];
  // ---- 段顺序: 决策项优先, 其余按规范七段顺序 ----
  const orderedSections = (() => {
    const byKey = new Map(parsed.sections.map((s) => [s.key, s]));
    const out: TodoSection[] = [];
    for (const k of SECTION_ORDER) {
      const s = byKey.get(k);
      if (s) { out.push(s); byKey.delete(k); }
    }
    for (const s of parsed.sections) if (byKey.has(s.key)) { out.push(s); byKey.delete(s.key); }
    return out;
  })();

  /** 从七段结构自动生成 meta (sections + 正文里的任务 id), 供历史待办补齐机器可读字段 */
  const buildMetaFromDetail = () => {
    const ids = new Set<string>();
    const re = /\b(c[a-z0-9]{20,})\b/g;
    let m: RegExpExecArray | null;
    const text = parsed.sections.map((s) => s.body).join("\n") + "\n" + parsed.raw;
    while ((m = re.exec(text))) ids.add(m[1]);
    return {
      sections: parsed.sections.map((s) => s.key),
      taskIds: Array.from(ids),
      generatedBy: "console:todo-detail (从七段结构自动识别)",
    };
  };
  const saveMeta = async () => {
    const next = buildMetaFromDetail();
    setMetaBusy(true);
    setMetaMsg(null);
    const r = await patchTodo({ id: todo.id, meta: next });
    setMetaBusy(false);
    if (r.ok) {
      setLocalMeta(r.todo?.meta && typeof r.todo.meta === "object" ? r.todo.meta : next);
      setMetaMsg(`已写入 meta: ${next.sections.length} 段 / ${next.taskIds.length} 个任务 id`);
      loadExtra();
    } else {
      setMetaMsg("写入失败: " + (r.error || "未知错误"));
    }
  };

  return (
    <div style={{ fontSize: "var(--fs-base)", lineHeight: 1.85 }}>
      {/* 顶部: 结构化状态 / 生成方 / 溯源 */}
      <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap", marginBottom: "var(--sp-2-5)" }}>
        {parsed.structured ? (
          <Pill tone="ok">结构化 {parsed.sections.length} 段</Pill>
        ) : (
          <Tooltip title="这条待办的 detail 未按《待办详情结构规范》的【】分段书写 (旧格式), 下方完整显示原文">
            <span><Pill tone="warn">旧格式</Pill></span>
          </Tooltip>
        )}
        {meta?.generatedBy ? <span className="tiny">生成方 {meta.generatedBy}</span> : null}
        {parsed.structured && !(Array.isArray(meta?.sections) && meta.sections.length) ? (
          <Tooltip title="把七段结构与正文里的任务 id 写成机器可读的 meta (mind 已支持 PATCH meta), 便于自动流程判断是否已结构化">
            <Button size="small" type="link" loading={metaBusy} onClick={saveMeta} style={{ padding: 0, fontSize: "var(--fs-sm)" }}>
              补齐 meta
            </Button>
          </Tooltip>
        ) : null}
        {todo?.evidence ? <span className="tiny">证据 {String(todo.evidence).slice(0, 60)}</span> : null}
        {todo?.note ? <span className="tiny">备注 {String(todo.note).slice(0, 60)}</span> : null}
        {metaMsg ? <span className="tiny" style={{ color: "var(--status-ok)" }}>{metaMsg}</span> : null}
      </div>

      {/* 2026-09-11 评审采纳: 负责人 / 当前状态 / 最近一次状态变更 / 优先级 / 截止 / 来源 —— 必须在详情里直接看到 */}
      <div
        style={{
          display: "grid", gap: "var(--sp-2)", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)",
          padding: "var(--sp-2-5) var(--sp-3)", marginBottom: "var(--sp-3)",
        }}
      >
        <div>
          <div className="tiny">负责人</div>
          <div style={{ fontSize: "var(--fs-base)" }}>
            <Pill tone={todo?.ownerType === "human" ? "warn" : todo?.ownerType === "agent" ? "info" : "mute"}>{ownerLabel}</Pill>
          </div>
        </div>
        <div>
          <div className="tiny">创建者</div>
          <div style={{ fontSize: "var(--fs-base)" }}>
            <span className="mono">{todo?.createdBy || "-"}</span>
            <span className="tiny" style={{ marginLeft: "var(--sp-1-5)" }}>{todo?.createdAt ? relTime(todo.createdAt) : ""}</span>
          </div>
        </div>
        <div>
          <div className="tiny">当前状态</div>
          <div style={{ fontSize: "var(--fs-base)" }}>
            <Pill tone={statusMeta[String(todo?.status)]?.tone || "mute"}>{statusMeta[String(todo?.status)]?.label || todo?.status || "-"}</Pill>
            {todo?.doneAt ? <span className="tiny" style={{ marginLeft: "var(--sp-1-5)" }}>完成于 {relTime(todo.doneAt)}{todo.doneBy ? " · " + todo.doneBy : ""}</span> : null}
          </div>
        </div>
        <div>
          <div className="tiny">最近一次状态变更</div>
          <div style={{ fontSize: "var(--fs-base)" }}>
            {lastChangeAt ? relTime(lastChangeAt) : "-"}
            <span className="tiny" style={{ marginLeft: "var(--sp-1-5)" }}>
              {lastStatusEvent ? `（${lastStatusEvent.text} · ${lastStatusEvent.actor}）` : "（创建后未变更过状态）"}
            </span>
          </div>
        </div>
        <div>
          <div className="tiny">优先级 / 截止</div>
          <div style={{ fontSize: "var(--fs-base)" }}>
            <span className="mono" style={{ color: PRIORITY_COLOR[todo?.priority] || "inherit", fontWeight: 600 }}>{todo?.priority || "-"}</span>
            <span className="tiny" style={{ marginLeft: "var(--sp-1-5)" }}>
              {todo?.dueAt ? new Date(todo.dueAt).toLocaleString("zh-CN", { hour12: false }) : "无截止"}
            </span>
          </div>
        </div>
        <div>
          <div className="tiny">来源</div>
          <div style={{ fontSize: "var(--fs-base)" }}>
            <Pill tone="mute">{todo?.source || "-"}</Pill>
            <span className="tiny mono" style={{ marginLeft: "var(--sp-1-5)" }}>{todo?.sourceRefId || "-"}</span>
            {extra?.source?.href ? <a href={extra.source.href} style={{ marginLeft: "var(--sp-1-5)" }}>打开 →</a> : null}
          </div>
        </div>
        <div>
          <div className="tiny">依赖与阻塞</div>
          <div style={{ fontSize: "var(--fs-base)" }}>
            {hasBlocking ? (
              <span style={{ color: "var(--status-crit)" }}>
                {blockedBy.length ? <span>被阻塞于 {blockedBy.join(", ")} </span> : null}
                {openBlockers.length ? <span>· 关联任务未完成 {openBlockers.length} 条</span> : null}
              </span>
            ) : (
              <span className="tiny" style={{ color: "var(--status-ok)" }}>无阻塞（没有未完成的阻塞依赖）</span>
            )}
          </div>
        </div>
      </div>

      {/* meta 机器字段 (核验统计等) */}
      {metaStats.length || metaScalars.length ? (
        <div style={{ display: "flex", gap: "var(--sp-2-5)", flexWrap: "wrap", marginBottom: "var(--sp-3)" }}>
          {metaStats.map((s) => (
            <div key={s.k} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg-surface2)", padding: "var(--sp-1) var(--sp-2-5)" }}>
              <div className="tiny">{s.k}</div>
              <div className="mono" style={{ fontSize: "var(--fs-md)", fontWeight: 600 }}>{String(s.v)}</div>
            </div>
          ))}
          {/* 2026-10-26：机器字段（kind=… / stormAlertFile=/home/…）不再平铺在正文里——
              那是日志腔，读者要的是「这条待办要你做什么」。收进「技术信息」折叠，需要时再看。 */}
          <details className="tech-detail">
            <summary>技术信息（{metaScalars.length} 项机器字段）</summary>
            <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap", marginTop: "var(--sp-2)" }}>
              {metaScalars.map(([k, v]) => (
                <span key={k} className="pill mute" style={{ fontSize: "var(--fs-xs)" }}>{k}={String(v)}</span>
              ))}
            </div>
          </details>
        </div>
      ) : null}

      {/* 分段渲染: 决策项优先 (可复算/需人决策), 其余按 背景 → 要做什么 → 验收标准 → 上下文与证据 → 影响与代价 → 时限 */}
      {parsed.structured ? (
        orderedSections.map((s) => {
          // 决策项已渲染成选项卡片时, 不再重复显示原始文字 (规范: 渲染为卡片而不是一段文字)
          const asCards = s.key === "decision" && textOptions.options.length > 0 && !(Array.isArray(meta?.options) && meta.options.length);
          return (
          <div key={s.key + s.title} style={{ marginBottom: "var(--sp-3)" }}>
            <div style={{ fontWeight: 700, color: "var(--primary)", marginBottom: "var(--sp-0-5)" }}>
              【{s.title}】{asCards ? <span className="tiny" style={{ fontWeight: 400 }}>（已转成下方选项卡片）</span> : null}
            </div>
            {asCards ? null : s.items.length ? (
              <ol style={{ margin: "var(--sp-0-5) 0 0 var(--sp-5)", padding: 0 }}>
                {s.items.map((it, i) => (
                  <li key={i} style={{ marginBottom: "var(--sp-0-5)" }}><RichText text={it} /></li>
                ))}
              </ol>
            ) : (
              <div style={{ wordBreak: "break-word", color: "var(--text-dim)" }}>
                <SectionBody body={s.body} />
              </div>
            )}
            {/* 决策项段: 选项卡片内联在此 (可复算/需人决策的部分优先呈现) */}
            {s.key === "decision" && options.length ? (
              <div style={{ display: "grid", gap: "var(--sp-2)", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginTop: "var(--sp-1-5)" }}>
                {options.map((o, i) => {
                  const isRec = (recommendedKey && o.key === recommendedKey) || (!recommendedKey && i === 0);
                  return (
                    <div
                      key={o.key}
                      className={"todo-option" + (onDecide ? " clickable" : "")}
                      onClick={onDecide ? () => pickOption(o) : undefined}
                      title={onDecide ? ("选择选项 " + o.key + "（预填到提交决定）") : undefined}
                      role={onDecide ? "button" : undefined}
                      style={{
                        border: "1px solid " + (isRec ? "var(--status-ok)" : "var(--border)"),
                        background: isRec ? "color-mix(in srgb, var(--status-ok) 7%, transparent)" : "var(--bg-surface2)",
                        borderRadius: "var(--radius-md)", padding: "var(--sp-2-5) var(--sp-3)",
                        cursor: onDecide ? "pointer" : "default",
                        transition: "box-shadow var(--c-transition, 0.2s)",
                      }}
                      onMouseEnter={onDecide ? (e: any) => { e.currentTarget.style.boxShadow = "0 0 0 2px var(--primary-dim)"; } : undefined}
                      onMouseLeave={onDecide ? (e: any) => { e.currentTarget.style.boxShadow = "none"; } : undefined}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-1-5)", marginBottom: "var(--sp-1)" }}>
                        <span className="mono" style={{ fontWeight: 700, color: isRec ? "var(--status-ok)" : "var(--text-dim)" }}>{o.key}</span>
                        {isRec ? <Pill tone="ok">推荐</Pill> : null}
                        {onDecide ? <span className="tiny" style={{ marginLeft: "auto", color: "var(--primary)" }}>选择</span> : null}
                      </div>
                      <div><RichText text={o.label} /></div>
                      {o.impact ? <div className="tiny" style={{ marginTop: "var(--sp-1)" }}>影响：<RichText text={String(o.impact)} /></div> : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
          );
        })
      ) : (
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-dim)" }}>
          <RichText text={parsed.raw || "(无详情)"} />
        </div>
      )}

      {/* 决策项选项卡片 (meta.options 优先, 否则从决策段文本兜底解析)
          —— 若已有决策段, 卡片已内联渲染在该段内, 这里不再重复 */}
      {options.length && !parsed.sections.some((s) => s.key === "decision") ? (
        <div style={{ marginTop: "var(--sp-3)" }}>
          <div style={{ fontWeight: 700, color: "var(--primary)", marginBottom: "var(--sp-1-5)" }}>
            决策选项{recommendedKey ? `（推荐 ${recommendedKey}）` : ""}
          </div>
          <div style={{ display: "grid", gap: "var(--sp-2)", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            {options.map((o, i) => {
              const isRec = (recommendedKey && o.key === recommendedKey) || (!recommendedKey && i === 0);
              return (
                <div
                  key={o.key}
                  className={"todo-option" + (onDecide ? " clickable" : "")}
                  onClick={onDecide ? () => pickOption(o) : undefined}
                  title={onDecide ? ("选择选项 " + o.key + "（预填到提交决定）") : undefined}
                  role={onDecide ? "button" : undefined}
                  style={{
                    border: "1px solid " + (isRec ? "var(--status-ok)" : "var(--border)"),
                    background: isRec ? "color-mix(in srgb, var(--status-ok) 7%, transparent)" : "var(--bg-surface2)",
                    borderRadius: "var(--radius-md)", padding: "var(--sp-2-5) var(--sp-3)",
                    cursor: onDecide ? "pointer" : "default",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-1-5)", marginBottom: "var(--sp-1)" }}>
                    <span className="mono" style={{ fontWeight: 700, color: isRec ? "var(--status-ok)" : "var(--text-dim)" }}>{o.key}</span>
                    {isRec ? <Pill tone="ok">推荐</Pill> : null}
                    {onDecide ? <span className="tiny" style={{ marginLeft: "auto", color: "var(--primary)" }}>选择</span> : null}
                  </div>
                  <div><RichText text={o.label} /></div>
                  {o.impact ? <div className="tiny" style={{ marginTop: "var(--sp-1)" }}>影响：<RichText text={String(o.impact)} /></div> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* ===== 关联任务卡片 (对齐任务详情页的"关联产物"区块) ===== */}
      {taskIds.length || (extra?.relatedTasks || []).length ? (
        <div style={{ marginTop: "var(--sp-3-5)" }}>
          <div style={{ fontWeight: 700, color: "var(--primary)", marginBottom: "var(--sp-1-5)", display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
            关联任务
            <span className="tiny" style={{ fontWeight: 400 }}>
              {fmtNum((extra?.relatedTasks || []).length || taskIds.length)} 个 · 来自 meta.taskIds
            </span>
            <Button size="small" type="link" icon={<ReloadOutlined />} loading={extraLoading} onClick={loadExtra} style={{ padding: 0 }}>刷新</Button>
          </div>
          {extraLoading && !extra ? (
            <Skeleton active paragraph={{ rows: 2 }} title={false} />
          ) : (extra?.relatedTasks || []).length ? (
            <div style={{ display: "grid", gap: "var(--sp-2)", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
              {(extra.relatedTasks || []).map((t: any) => (
                <a
                  key={t.id}
                  href={`/flywheel/tasks/${t.id}`}
                  className="todo-task-card"
                  style={{
                    display: "block", textDecoration: "none", color: "inherit",
                    border: "1px solid var(--border)", borderRadius: "var(--radius-md)",
                    background: "var(--bg-surface)", padding: "var(--sp-2) var(--sp-3)",
                  }}
                  title={`打开任务详情 ${t.id}`}
                >
                  <div style={{ fontSize: "var(--fs-base)", lineHeight: 1.5, marginBottom: "var(--sp-1)" }}>{t.title}</div>
                  <div style={{ display: "flex", gap: "var(--sp-1-5)", alignItems: "center", flexWrap: "wrap" }}>
                    <Tag color={TASK_STATUS_TAG[t.status]?.color || "default"} style={{ marginInlineEnd: 0 }}>
                      {TASK_STATUS_TAG[t.status]?.label || t.status}
                    </Tag>
                    <span className="mono" style={{ color: PRIORITY_COLOR[t.priority] || "var(--text-muted)", fontSize: "var(--fs-sm)", fontWeight: 600 }}>{t.priority}</span>
                    {t.improvementType ? <span className="tiny">{t.improvementType}</span> : null}
                    <span className="tiny">👤 {t.assignedAgent || "未指派"}</span>
                    <span className="tiny" style={{ marginLeft: "auto" }}>{t.updatedAt ? relTime(t.updatedAt) : "-"}</span>
                  </div>
                  <div className="tiny mono" style={{ marginTop: "var(--sp-0-5)" }}>{t.id} →</div>
                </a>
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
              {taskIds.map((id) => (
                <a key={id} href={`/flywheel/tasks/${id}`} className="pill info" style={{ textDecoration: "none", fontFamily: "var(--font-mono)" }} title={`打开任务 ${id}`}>
                  {id.slice(0, 12)}… →
                </a>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* ===== 处理时间线 (对齐任务详情页的"状态流转/执行链") ===== */}
      <div style={{ marginTop: "var(--sp-3-5)" }}>
        <div style={{ fontWeight: 700, color: "var(--primary)", marginBottom: "var(--sp-1-5)", display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          处理时间线
          <span className="tiny" style={{ fontWeight: 400 }}>{t('todo.timelineFrom')}</span>
        </div>
        {extraLoading && !extra ? (
          <Skeleton active paragraph={{ rows: 2 }} title={false} />
        ) : (extra?.timeline || []).length ? (
          <Timeline
            items={(extra.timeline || []).map((t: any, i: number) => ({
              key: i,
              color: t.kind === "done" ? "green" : t.kind === "created" ? "blue" : "gray",
              content: (
                <div style={{ fontSize: "var(--fs-base)" }}>
                  <span style={{ marginRight: "var(--sp-1-5)" }}>{t.text}</span>
                  <span className="actor-chip platform">{t.actor || "-"}</span>
                  <span className="tiny" style={{ marginLeft: "var(--sp-2)" }}>{relTime(t.at)}</span>
                </div>
              ),
            }))}
          />
        ) : (
          <div className="tiny">暂无状态变更记录（该待办创建后没有被改过状态）。</div>
        )}
      </div>

      {/* ===== 来源回溯 ===== */}
      {extra?.source ? (
        <div style={{ marginTop: "var(--sp-3-5)" }}>
          <div style={{ fontWeight: 700, color: "var(--primary)", marginBottom: "var(--sp-1)" }}>来源回溯</div>
          <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap", fontSize: "var(--fs-base)" }}>
            <Pill tone="mute">source={extra.source.source || "-"}</Pill>
            <span className="tiny">{t('field.sourceRefId')} <span className="mono">{extra.source.sourceRefId || "-"}</span></span>
            {extra.source.resolved ? (
              <span>
                解析为 <b>{extra.source.resolved.kind}</b>：{extra.source.resolved.title}
                {extra.source.resolved.status ? <span className="tiny">（{extra.source.resolved.status}）</span> : null}
              </span>
            ) : null}
            {extra.source.href ? <a href={extra.source.href}>打开来源对象 →</a> : <span className="tiny">（该来源类型无对应页面）</span>}
          </div>
        </div>
      ) : null}

      {/* meta.links → 外部/页面链接 */}
      {metaLinks.length ? (
        <div style={{ marginTop: "var(--sp-3)" }}>
          <div style={{ fontWeight: 700, color: "var(--primary)", marginBottom: "var(--sp-1)" }}>相关链接</div>
          <div style={{ display: "flex", gap: "var(--sp-2-5)", flexWrap: "wrap" }}>
            {metaLinks.map((l, i) => (
              <a key={i} href={l.url} target={String(l.url).startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="tiny">{l.label} →</a>
            ))}
          </div>
        </div>
      ) : null}

      {/* ===== 讨论 (与任务详情页一致: 任何实体都能针对它做 AI 沟通) ===== */}
      <div style={{ marginTop: "var(--sp-3-5)" }}>
        <DiscussionPanel entityType="todo" entityId={todo?.id} title="待办讨论与协作" />
      </div>
    </div>
  );
}
