"use client";
// 0.6 平台模型配置页（SLOT-MAP 完整实现，2026-11-16）
// 派单：[team] msg_afdb04ed17da47a2；设计基线：
//   [internal-doc]
// 槽位：页头 s12（标题+副标题+chips4+数据时刻）/ KPI 4×s3 / 区块A s8+s4 / 区块B s8+s4 /
//       区块C s12 / 审计回显 s12 / 相关视图 s12。
//
// 硬约束（用户/运营团队明确要求）：
//   1) key 只显示尾号，绝不渲染明文、不进日志；审计回显只列变更键名，不列值；
//   2) 显示「配置 mtime vs 进程启动」核对结果（mtimeFresh=false -> 可能未生效告警）；
//   3) selfimproving 标注「用户指示暂不切（2026-11-16）」，切换默认锁定，解锁需 force + 二次确认；
//   4) 取不到数据一律 n/a + 原因，不编造、不写 0 冒充；测试调用只回 HTTP 码 + 首 20 字；
//   5) 测试红绿判据：2xx + 非空回复 = 绿；空回复或非 2xx = 红（带状态码/耗时）。
import { useEffect, useMemo, useState } from "react";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
// 0.6.2 U-51：智能体团队 / 全双工配置分组（字段名 agent_team，与 [team] 对齐）
import TeamDuplexSection from "./_components/TeamDuplexSection";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import { Chips, KpiTile, Note, States, Tone, usePhaseOverride, useResource } from "../_components/bento-kit";
import kit from "../_components/bento-kit.module.css";
import s from "./page.module.css";

/**
 * 写页开关：true = 编辑页（chips 第 3 个显示「编辑」，切换链路可用）。
 * 骨架期回退只需改 false（chips 自动回「只读」、切换按钮全部 disabled），不删代码。
 */
const WRITE_ENABLED = true;

/** 配置点：与 GET /api/model-config 契约一一对应（字段拿不到时页面显示 n/a+原因）。 */
interface Point {
  id: string;
  name: string;
  group: string;
  model?: string;
  baseUrl?: string;
  keyTail?: string;        // 只有尾号，服务端已掩码
  unit?: string;
  unitActive?: boolean;
  startedAt?: string;      // 进程启动时刻
  configMtime?: string;    // 配置文件 mtime
  mtimeFresh?: boolean;    // configMtime <= startedAt（false = 改了没重启）
  locked?: boolean;        // selfimproving 等锁定项
  lockReason?: string;
  unavailable?: string;    // 读不到的原因（如等 devops ssh 通道）
  machine?: string;        // 区块C：agent 所在机器
  machineNote?: string;    // 区块C：机器列取不到的原因
  brain?: string;          // 区块C：brain 类型
  provider?: string;       // 区块C：当前 provider
  fallback?: string;       // 区块C：降级通道
  testable?: boolean;      // false = 走网关链路，不提供直连测试
  envFile?: string;        // 承载文件（confirm 弹窗复述目标文件，不含值）
  unitNote?: string;       // 没有单元状态的原因（本点数据是有的，区别于 unavailable）
}
interface Group { id: string; title: string; envFile?: string; points: Point[] }
interface KeyHealth {
  total: number;
  configured: number;
  keyTotal: number;
  globalConfigured: number;
  missing: string[];
  sources: Array<{ file: string; configured: number; total: number }>;
}
interface ConfigResp { ok: boolean; groups?: Group[]; asOf?: string; keyHealth?: KeyHealth | null }

interface Provider { id: string; name?: string; baseUrl?: string; transport?: string; discoverModels: boolean; models: string[]; source: string }
interface CatalogResp { ok: boolean; providers?: Provider[]; asOf?: string; error?: string }

interface AuditRow { at: string; actor: string; action: string; keys: string[]; result: string }
interface AuditResp { ok: boolean; items?: AuditRow[]; asOf?: string; error?: string }

interface TestResult { httpStatus?: number; ok?: boolean; replyFirst20?: string; error?: string; elapsedMs?: number }

const NA = "n/a";
const fmt = (v?: string | null) => (v && v.trim() ? v : NA);
const clock = (iso?: string | null) => {
  if (!iso) return NA;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return NA;
  return t.toLocaleString("zh-CN", { hour12: false });
};

/** mtimeFresh=false -> 配置已改但进程未重启（历史坑：改了不重启不生效）。 */
function Freshness({ p }: { p: Point }) {
  if (!p.configMtime && !p.startedAt) return <Tone tone="mute">{NA}</Tone>;
  if (p.mtimeFresh === false) return <Tone tone="warn">配置已改但进程未重启（可能未生效）</Tone>;
  if (p.mtimeFresh === true) return <Tone tone="ok">已生效</Tone>;
  // 判据③（2026-11-16 运营团队/platform-data）：同秒相等 -> 必须 n-a + 原因，不得默认任一态
  if (p.configMtime && p.startedAt) {
    return <Tone tone="mute">{NA}（配置 mtime 与进程启动时刻同秒，无法判定先后；可重启后再看）</Tone>;
  }
  return <Tone tone="mute">{NA}</Tone>;
}

interface Draft { provider?: string; baseUrl?: string; model?: string }

/** 区块 A/B 单配置点行：现值 + 切换控件（下拉）+ 测试调用 + 保存。 */
function PointRow({ p, providers, catalogReady, catalogReason, draft, onPick, onTest, testing, result, onSwitch, onUnlock, unlocked, saving }: {
  p: Point;
  providers: Provider[];
  catalogReady: boolean;
  catalogReason: string;
  draft?: Draft;
  onPick: (d: Draft) => void;
  onTest: () => void;
  testing: boolean;
  result?: TestResult;
  onSwitch: () => void;
  onUnlock: () => void;
  unlocked: boolean;
  saving: boolean;
}) {
  const d = draft || {};
  // 设计 裁决 2026-11-16（三种状态，不是两态）：供应商匹配按 host 而非整串 URL
  //   exact     = URL 完全相同（目录登记的默认路径）
  //   same-host = host 相同但路径不同（如目录 /v1、配置 /anthropic，同一供应商的兼容路径变体）
  //   none      = host 都不匹配 -> 才是「自定义地址」
  const curMatch = useMemo(() => {
    const hostOf = (u?: string) => { try { return u ? new URL(u).host : ""; } catch { return ""; } };
    const pathOf = (u?: string) => { try { return u ? new URL(u).pathname : ""; } catch { return ""; } };
    const host = hostOf(p.baseUrl);
    if (p.baseUrl) {
      const exact = providers.find((x) => x.baseUrl && x.baseUrl === p.baseUrl);
      if (exact) return { kind: "exact" as const, id: exact.id, path: pathOf(p.baseUrl) };
      if (host) {
        const sh = providers.find((x) => hostOf(x.baseUrl) === host);
        if (sh) return { kind: "same-host" as const, id: sh.id, path: pathOf(p.baseUrl) };
      }
    }
    return { kind: "none" as const, id: "", path: "" };
  }, [providers, p.baseUrl]);
  const curProvider = curMatch.id;
  const providerId = d.provider ?? curProvider;
  const provider = providers.find((x) => x.id === providerId);
  const modelList = useMemo(() => {
    const base = provider?.models || [];
    const cur = d.model ?? p.model;
    // 当前模型不在目录里也保留为可选项，避免被迫改动（防 404 的前提是不动就不报错）。
    return cur && !base.includes(cur) ? [cur, ...base] : base;
  }, [provider, d.model, p.model]);

  const changedKeys: string[] = [];
  if (d.model !== undefined && d.model !== p.model) changedKeys.push("ANTHROPIC_MODEL");
  if (d.baseUrl !== undefined && d.baseUrl !== p.baseUrl) changedKeys.push("ANTHROPIC_BASE_URL");
  const dirty = changedKeys.length > 0;

  const lockBlocked = !!p.locked && !unlocked;
  const canSwitch = WRITE_ENABLED && !p.unavailable && !lockBlocked && dirty;

  return (
    <li className={s.pointRow} data-testid={"point-" + p.id}>
      <div className={s.pointMain}>
        <span className={s.pointName}>{p.name}</span>
        {p.locked ? <Tone tone="warn">锁定{p.lockReason ? "：" + p.lockReason : ""}</Tone> : null}
        {p.unavailable ? <Tone tone="mute">{NA}：{p.unavailable}</Tone> : null}
        {p.locked && unlocked ? <Tone tone="info">已解锁（本次会话）</Tone> : null}
      </div>

      <div className={s.pointMeta}>
        <span>模型 <b>{fmt(d.model ?? p.model)}</b></span>
        <span>地址 <b>{fmt(d.baseUrl ?? p.baseUrl)}</b></span>
        <span>密钥尾号 <b>{fmt(p.keyTail)}</b></span>
        <span>
          单元 {p.unit ? <b>{p.unit}</b> : p.unitNote ? <span>{NA}（{p.unitNote}）</span> : <b>{NA}</b>}
          {p.unit ? (p.unitActive ? "（运行中）" : "（未运行）") : ""}
        </span>
        <span>启动 <b>{fmt(p.startedAt)}</b></span>
        <span>配置时间 <b>{fmt(p.configMtime)}</b></span>
        <span><Freshness p={p} /></span>
      </div>

      {/* 切换控件：选项来自目录接口；目录不可得 -> 下拉 disabled + n/a 原因 */}
      <div className={s.switchRow}>
        <label className={s.field}>
          <span>供应商</span>
          <select
            className={s.select}
            data-testid={"provider-" + p.id}
            disabled={!WRITE_ENABLED || !catalogReady || lockBlocked}
            value={providerId}
            onChange={(e) => {
              const next = providers.find((x) => x.id === e.target.value);
              onPick({ ...d, provider: e.target.value, baseUrl: next?.baseUrl, model: undefined });
            }}
          >
            {!catalogReady ? <option value="">{NA}（模型目录不可得）</option> : null}
            {/* 设计 裁决：三态显示（精确 = 不额外加项；同 host 路径不同 = 标注当前路径；host 不匹配 = 自定义地址） */}
            {catalogReady && curMatch.kind === "same-host" ? (
              <option value={curMatch.id}>
                {(providers.find((x) => x.id === curMatch.id)?.name || curMatch.id)}（当前路径 {curMatch.path}）
              </option>
            ) : null}
            {catalogReady && curMatch.kind === "none" ? <option value="">自定义地址（不在目录）</option> : null}
            {providers.map((x) => <option key={x.id} value={x.id}>{x.name || x.id}</option>)}
          </select>
        </label>
        <label className={s.field}>
          <span>模型</span>
          <select
            className={s.select}
            data-testid={"model-" + p.id}
            disabled={!WRITE_ENABLED || !catalogReady || lockBlocked || modelList.length === 0}
            value={d.model ?? p.model ?? ""}
            onChange={(e) => onPick({ ...d, model: e.target.value })}
          >
            {modelList.length === 0 ? <option value="">{NA}（目录未提供模型列表）</option> : null}
            {modelList.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        {catalogReason ? <span className={s.fieldNote}>{NA}：{catalogReason}</span> : null}
        {/* 协议不匹配预警：本配置点按当前调用方式直连，选到不同协议的供应商可能不可用 */}
        {provider && /openai/i.test(provider.transport || "") && (d.baseUrl ?? p.baseUrl) ? (
          <span className={s.fieldWarn}>所选供应商与本配置点当前调用方式不同，切换后可能不可用，请先确认。</span>
        ) : null}
      </div>

      <div className={s.pointActions}>
        <button
          type="button"
          className="btn"
          data-testid={"test-" + p.id}
          disabled={testing || !!p.unavailable || p.testable === false}
          title={p.testable === false ? "该点经网关链路，不提供直连测试" : p.unavailable ? p.unavailable : "发一次最小提示词自检"}
          onClick={onTest}
        >
          {testing ? "测试中…" : "测试调用"}
        </button>

        {p.locked && !unlocked ? (
          <button type="button" className="btn" data-testid={"unlock-" + p.id} onClick={onUnlock} title={p.lockReason || "锁定项，解锁需二次确认"}>
            解锁
          </button>
        ) : null}

        <button
          type="button"
          className="btn"
          data-testid={"switch-" + p.id}
          disabled={!canSwitch || saving}
          title={p.unavailable ? p.unavailable : lockBlocked ? "已锁定，需先解锁" : !dirty ? "没有待保存的改动" : "复述键名后确认写入"}
          onClick={onSwitch}
        >
          {saving ? "保存中…" : dirty ? "保存" : "切换"}
        </button>
        {dirty ? <Tone tone="info">待保存 {changedKeys.length} 项</Tone> : null}
      </div>

      {result ? (
        <div className={s.pointResult} data-testid={"result-" + p.id}>
          {result.error ? (
            <Tone tone="crit">{result.error}</Tone>
          ) : (
            <>
              {/* 红绿判据：2xx + 非空 = 绿；空回复或非 2xx = 红（带状态码/耗时） */}
              <Tone tone={result.ok ? "ok" : "crit"}>
                响应码 {result.httpStatus ?? NA}{typeof result.elapsedMs === "number" ? " · " + result.elapsedMs + "ms" : ""}
              </Tone>
              <span>{result.ok ? result.replyFirst20 : "未取得非空回复"}</span>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

export default function ModelConfigPage() {
  const res = useResource<ConfigResp>("/api/model-config", { pollMs: 60000 });
  const cat = useResource<CatalogResp>("/api/model-config/catalog", { pollMs: 300000, emptyWhen: (d) => !d.providers?.length });
  const aud = useResource<AuditResp>("/api/model-config/audit", { pollMs: 60000, emptyWhen: (d) => !d.items?.length });
  const forced = usePhaseOverride();
  const phase = forced && forced !== "ok" ? forced : res.phase;

  const [reqAt, setReqAt] = useState("");
  useEffect(() => { if (res.phase === "ok") setReqAt(new Date().toISOString()); }, [res.phase, res.data]);

  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [unlockFor, setUnlockFor] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [unlocked, setUnlocked] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<{ tone: "ok" | "crit"; text: string } | null>(null);
  const [lastFail, setLastFail] = useState<{ at: string; text: string } | null>(null);

  const groups = res.data?.groups ?? [];
  const byId = (id: string) => groups.find((g) => g.id === id);
  const providers = cat.data?.providers ?? [];
  const catalogReady = cat.phase === "ok" && providers.length > 0;
  const catalogReason = catalogReady ? "" : (cat.phase === "empty" ? "模型目录返回空集" : cat.phase === "ok" ? "模型目录不可得" : (cat.error || "模型目录读取中"));

  const kh = res.data?.keyHealth ?? null;
  const dirtyCount = Object.keys(drafts).length;
  const pending = dirtyCount + (saving ? 1 : 0);

  const showToast = (tone: "ok" | "crit", text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 6000);
  };

  // 测试调用：只落 HTTP 码 + 首 20 字回显；请求体/prompt 不进任何日志（服务端同约束）。
  const runTest = async (pointId: string) => {
    setTesting(pointId);
    const t0 = Date.now();
    try {
      const r = await fetch("/api/model-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test-call", point: pointId, confirm: true }),
      });
      const j = (await r.json().catch(() => ({}))) as TestResult;
      const elapsed = Date.now() - t0;
      const next: TestResult = r.ok && j.error === undefined
        ? { httpStatus: j.httpStatus, ok: j.ok, replyFirst20: j.replyFirst20, elapsedMs: elapsed }
        : { error: j.error || "测试调用未通过（返回码 " + r.status + "）", elapsedMs: elapsed };
      setResults((prev) => ({ ...prev, [pointId]: next }));
      if (next.error || !next.ok) setLastFail({ at: new Date().toISOString(), text: "测试调用：" + (next.error || "响应码 " + next.httpStatus + " 未取得非空回复") });
    } catch {
      const next: TestResult = { error: "网络不可达", elapsedMs: Date.now() - t0 };
      setResults((prev) => ({ ...prev, [pointId]: next }));
      setLastFail({ at: new Date().toISOString(), text: "测试调用：网络不可达" });
    } finally {
      setTesting(null);
    }
  };

  const confirmPoint = groups.flatMap((g) => g.points).find((p) => p.id === confirmFor);
  const unlockPoint = groups.flatMap((g) => g.points).find((p) => p.id === unlockFor);

  const changedKeysOf = (p: Point) => {
    const d = drafts[p.id] || {};
    const keys: string[] = [];
    if (d.model !== undefined && d.model !== p.model) keys.push("ANTHROPIC_MODEL");
    if (d.baseUrl !== undefined && d.baseUrl !== p.baseUrl) keys.push("ANTHROPIC_BASE_URL");
    return keys;
  };

  const doSwitch = async () => {
    if (!confirmPoint) return;
    const d = drafts[confirmPoint.id] || {};
    const body: Record<string, unknown> = {
      action: "switch",
      point: confirmPoint.id,
      confirm: true,
      ...(d.model !== undefined && d.model !== confirmPoint.model ? { model: d.model } : {}),
      ...(d.baseUrl !== undefined && d.baseUrl !== confirmPoint.baseUrl ? { baseUrl: d.baseUrl } : {}),
      ...(confirmPoint.locked ? { force: true } : {}),
    };
    setSaving(confirmPoint.id);
    setConfirmFor(null);
    setAck(false);
    try {
      const r = await fetch("/api/model-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; restart?: { hint?: string }; note?: string };
      if (r.ok && j.ok !== false) {
        setDrafts((prev) => { const n = { ...prev }; delete n[confirmPoint.id]; return n; });
        showToast("ok", "已写入：" + confirmPoint.name + "（" + (j.restart?.hint || j.note || "需重启对应单元后生效") + "）");
        res.reload();
        aud.reload();
      } else {
        const text = j.error || "切换失败（返回码 " + r.status + "）";
        setLastFail({ at: new Date().toISOString(), text: "切换 " + confirmPoint.name + "：" + text });
        showToast("crit", text + "（端点 /api/model-config · 返回码 " + r.status + "）");
      }
    } catch {
      setLastFail({ at: new Date().toISOString(), text: "切换 " + confirmPoint.name + "：网络不可达" });
      showToast("crit", "网络不可达（端点 /api/model-config，可重试）");
    } finally {
      setSaving(null);
    }
  };

  const renderGroup = (g?: Group) => {
    if (!g) return <Note tone="warn">该区块数据不可得（{NA} + 原因见上）</Note>;
    if (!g.points?.length) return <Note tone="mute">暂无配置点（接口返回空集，不显示 0 冒充）</Note>;
    return (
      <ul className={s.pointList}>
        {g.points.map((p) => (
          <PointRow
            key={p.id}
            p={p}
            providers={providers}
            catalogReady={catalogReady}
            catalogReason={catalogReason}
            draft={drafts[p.id]}
            onPick={(d) => setDrafts((prev) => ({ ...prev, [p.id]: d }))}
            testing={testing === p.id}
            result={results[p.id]}
            onTest={() => void runTest(p.id)}
            onSwitch={() => { setConfirmFor(p.id); setAck(false); }}
            onUnlock={() => { setUnlockFor(p.id); setAck(false); }}
            unlocked={!!unlocked[p.id]}
            saving={saving === p.id}
          />
        ))}
      </ul>
    );
  };

  const fleet = byId("fleet");
  const fleetPoints = fleet?.points ?? [];

  // 配置点数 = 已配键/总键（键口径，与下方「缺失键数」互补：已配 + 缺失 = 总键）
  const kpiPoints = kh
    ? {
        kind: "value" as const,
        value: kh.globalConfigured + "/" + kh.keyTotal,
        tone: (kh.globalConfigured === kh.keyTotal ? "ok" : "warn") as "ok" | "warn",
        hint: kh.sources.map((x) => x.file + " " + x.configured + "/" + x.total).join(" · ") || "来源文件不可得",
      }
    : { kind: "na" as const, reason: "键健康汇总不可得（接口未下发）" };
  const kpiPending = {
    kind: "value" as const,
    value: pending,
    unit: pending ? " 项挂起" : " 项",
    tone: (pending ? "warn" : "ok") as "warn" | "ok",
    hint: "未保存改动 " + dirtyCount + " · 写请求中 " + (saving ? 1 : 0),
  };
  const kpiFail = lastFail
    ? { kind: "value" as const, value: clock(lastFail.at), tone: "crit" as const, hint: lastFail.text }
    : { kind: "value" as const, value: "无", tone: "ok" as const, hint: "本会话无测试/保存失败" };
  // 掩码健康 = 缺失键数（与「配置点数」互补），hint 带总键/已配 + 缺失键名
  const kpiMask = kh
    ? {
        kind: "value" as const,
        value: kh.missing.length,
        unit: " 键缺失",
        tone: (kh.missing.length ? "warn" : "ok") as "warn" | "ok",
        hint: kh.missing.length
          ? "总键 " + kh.keyTotal + " · 已配 " + kh.globalConfigured + " · " + kh.missing.join(" · ")
          : "总键 " + kh.keyTotal + " 全部已配置；回显只给尾号",
      }
    : { kind: "na" as const, reason: "键健康汇总不可得（接口未下发）" };

  const asOf = res.data?.asOf || reqAt;
  const asOfLabel = res.data?.asOf ? "数据时刻" : (reqAt ? "请求时刻" : NA);

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>模型配置</PageTitle>
        <div className="page-subtitle">
          密钥只显示尾号；保存后需重启对应单元才生效；平台不代付模型费用。数据时刻见下方标注。
        </div>
        <div className={s.asOfRow} data-testid="asof">
          {asOfLabel}：{clock(asOf)}
          {res.data?.asOf ? null : <span className={s.asOfNote}>（接口未下发取数时刻，此处记请求时刻）</span>}
        </div>
      </PageHeader>

      {/* 0.6.2 U-51：智能体团队 / 全双工配置（与模型配置同页分组；U-52 会收敛成设置中心） */}
      <TeamDuplexSection embedded />

      <Chips group="系统" page="模型配置" readonly={!WRITE_ENABLED} />

      <States
        phase={phase}
        endpoint="/api/model-config"
        error={res.error}
        status={res.status}
        onRetry={res.reload}
        emptyTitle="暂无配置点"
        emptyDetail="接口返回空集；不显示 0 冒充。"
      />

      {phase === "ok" ? (
        <BentoGrid>
          {/* KPI 4×s3：配置点数 / 切换中 / 最近失败 / 掩码健康（基线 §1 + §5 口径） */}
          <KpiTile span={3} label="配置点数" metric={kpiPoints} />
          <KpiTile span={3} label="切换中" metric={kpiPending} />
          <KpiTile span={3} label="最近失败" metric={kpiFail} />
          <KpiTile span={3} label="掩码健康" metric={kpiMask} />

          {/* 区块 A s8 + 说明 s4 */}
          <BentoCard span={8} title="飞轮模型" sub="6 模块共用一份配置（反思 / 结构化 / 改进任务 / 全局组织 / 认知提取 / 标题生成）">
            {renderGroup(byId("flywheel"))}
          </BentoCard>
          <BentoCard span={4} title="区块说明">
            <ul className={s.noteList}>
              <li>6 个模块共用同一份 <b>mind.env</b>，改一处即全部生效。</li>
              <li>保存后需重启 <b>lions-mind</b> 才生效；页面按「配置时间 vs 进程启动」判断。</li>
              <li><b>覆盖范围</b>：「已生效」判断只看 4 个 <code>~/.config/lions/*.env</code>（mind.env / session-extract-model.env / sales-mind-model.env / selfimproving-llm.env）。<b>systemd drop-in（<code>lions-mind.service.d/*.conf</code>）与 hermes-gateway env 不在覆盖范围</b>——改了它们请自行重启确认，页面不会提示。</li>
              <li>密钥只回尾号，页面与日志都不出现明文。</li>
              <li>保存前会复述变更键名与目标文件，不显示任何值。</li>
            </ul>
          </BentoCard>

          {/* 区块 B s8 + 说明 s4 */}
          <BentoCard span={8} title="平台其他模型" sub="会话提取 / 销售 mind / 自我改进（后者按用户指示暂不切）">
            {renderGroup(byId("platform"))}
            <Note tone="warn">自我改进 selfimproving：用户指示暂不切（2026-11-16），切换默认锁定，解锁需二次确认。</Note>
          </BentoCard>
          <BentoCard span={4} title="区块说明">
            <ul className={s.noteList}>
              <li>三个配置点各自独立文件，互不影响。</li>
              <li>切换归属本页写入；重启单元后生效（页面显示是否已生效）。</li>
              <li>selfimproving 默认锁定：需先「解锁」二次确认，保存时才允许写入。</li>
              <li>写入前自动备份，审计写不出来即拒绝写入（失败不落盘）。</li>
            </ul>
          </BentoCard>

          {/* 区块 C s12：7 agent 主表（横向滚动 + 首列 sticky） */}
          <BentoCard span={12} title="智能体模型" sub="7 台智能体的所在机器 / 执行大脑 / 供应商 / 模型 / 运行状态（配置本机直读，远程机器状态待采集）">
            {fleetPoints.length === 0 ? (
              <Note tone="mute">无智能体模型登记</Note>
            ) : (
              <div className={s.tableWrap}>
                <table className={s.table} data-testid="fleet-table">
                  <thead>
                    <tr>
                      <th className={s.stickyCol}>智能体</th>
                      <th>所在机器</th>
                      <th>执行大脑</th>
                      <th>供应商</th>
                      <th>模型</th>
                      <th>降级通道</th>
                      <th>运行状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fleetPoints.map((p) => (
                      <tr key={p.id} data-testid={"fleet-" + p.id}>
                        <td className={s.stickyCol}><b>{p.name}</b></td>
                        <td>
                          {p.machine ? <span>{p.machine}</span>
                            : <Tone tone="mute">{NA}：{p.machineNote || "机器状态不可得"}</Tone>}
                        </td>
                        <td>{fmt(p.brain)}</td>
                        <td>{fmt(p.provider)}</td>
                        <td>{fmt(p.model)}</td>
                        <td>{fmt(p.fallback)}</td>
                        <td>
                          {p.unavailable ? <Tone tone="mute">{NA}：{p.unavailable}</Tone>
                            : p.unitActive === undefined ? <Tone tone="mute">{NA}（远程单元状态待采集）</Tone>
                              : p.unitActive ? <Tone tone="ok">运行中</Tone> : <Tone tone="warn">未运行</Tone>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Note tone="mute">远程机器（100 / 104）的机器列与单元状态需 devops 采集通道；取不到时显示 n/a + 原因，不编造。</Note>
          </BentoCard>

          {/* 审计回显 s12：最近 10 条，只列变更键名，不列值 */}
          <BentoCard span={12} title="变更记录" sub="最近 10 条平台配置变更（只列变更键名，不显示任何值）">
            {/* 判据看服务端 ok 而非 phase：空集是「无变更记录」，取不到才是 n/a（不把取不到当空） */}
            {aud.phase === "loading" ? <Note tone="mute">变更记录读取中…</Note>
              : aud.data?.ok !== true ? (
                <Note tone="warn">{NA}：变更记录暂不可得（返回码 {aud.status ?? NA}，可重试）{aud.data?.error || aud.error ? " · " + (aud.data.error || aud.error) : ""}</Note>
              )
                : !aud.data.items?.length ? <Note tone="mute">无变更记录</Note>
                  : (
                    <div className={s.tableWrap}>
                      <table className={s.table} data-testid="audit-table">
                        <thead>
                          <tr><th>时间</th><th>操作者</th><th>动作</th><th>变更键</th><th>结果</th></tr>
                        </thead>
                        <tbody>
                          {aud.data.items.map((a, i) => (
                            <tr key={(a.at || "") + i}>
                              <td>{clock(a.at)}</td>
                              <td>{fmt(a.actor)}</td>
                              <td>{fmt(a.action)}</td>
                              <td>{a.keys.length ? a.keys.join("、") : NA + "（未记录键名）"}</td>
                              <td>{a.result === "成功" ? <Tone tone="ok">成功</Tone> : <Tone tone="crit">{a.result}</Tone>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
          </BentoCard>

          {/* 相关视图 s12 */}
          <BentoCard span={12} title="相关视图">
            <Note>
              相关视图：
              <a className={kit.link} href="/system/health">平台健康</a> ·
              <a className={kit.link} href="/system/permissions">权限管理</a> ·
              <a className={kit.link} href="/system/version-board">发布看板</a>
            </Note>
          </BentoCard>
        </BentoGrid>
      ) : null}

      {toast ? (
        <div className={s.toast} data-tone={toast.tone} role="status">{toast.text}</div>
      ) : null}

      {/* confirm 弹窗：复述变更键名 + 目标文件，不显示值（基线 §2 保存契约） */}
      {confirmPoint ? (
        <div className={s.mask} role="dialog" aria-modal="true" aria-label="确认切换">
          <div className={s.modal} data-testid="confirm-dialog">
            <h3 className={s.modalTitle}>确认切换</h3>
            <p className={s.modalLine}>配置点：<b>{confirmPoint.name}</b></p>
            <p className={s.modalLine}>目标文件：<b className={s.mono}>{confirmPoint.envFile || NA}</b></p>
            <p className={s.modalLine}>变更键（不显示值）：</p>
            <ul className={s.keyList}>
              {changedKeysOf(confirmPoint).map((k) => <li key={k} className={s.mono}>{k}</li>)}
            </ul>
            {confirmPoint.locked ? (
              <p className={s.modalWarn}>该配置点已锁定：{confirmPoint.lockReason || "用户指示暂不切"}。本次为解锁后写入，将携带强制标记。</p>
            ) : null}
            <p className={s.modalLine}>写入前自动备份；审计写不出来会拒绝写入。</p>
            <label className={s.ack}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              我已核对配置点、目标文件与变更键名
            </label>
            <div className={s.modalActions}>
              <button type="button" className="btn" onClick={() => { setConfirmFor(null); setAck(false); }}>取消</button>
              <button type="button" className="btn" data-testid="confirm-ok" disabled={!ack || changedKeysOf(confirmPoint).length === 0} onClick={() => void doSwitch()}>
                确认切换
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 解锁二次确认（force 的前置动作，不涉及任何值） */}
      {unlockPoint ? (
        <div className={s.mask} role="dialog" aria-modal="true" aria-label="确认解锁">
          <div className={s.modal} data-testid="unlock-dialog">
            <h3 className={s.modalTitle}>确认解锁</h3>
            <p className={s.modalLine}>配置点：<b>{unlockPoint.name}</b></p>
            <p className={s.modalLine}>锁定原因：{unlockPoint.lockReason || "用户指示暂不切"}</p>
            <p className={s.modalLine}>目标文件：<b className={s.mono}>{unlockPoint.envFile || NA}</b></p>
            <p className={s.modalWarn}>解锁只在本会话生效；解锁后仍需再次确认键名才会写入。</p>
            <label className={s.ack}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              我已知晓锁定原因并确认解锁
            </label>
            <div className={s.modalActions}>
              <button type="button" className="btn" onClick={() => { setUnlockFor(null); setAck(false); }}>取消</button>
              <button type="button" className="btn" data-testid="unlock-ok" disabled={!ack} onClick={() => {
                setUnlocked((prev) => ({ ...prev, [unlockPoint.id]: true }));
                setUnlockFor(null);
                setAck(false);
                showToast("ok", "已解锁（仅本次会话）：" + unlockPoint.name);
              }}>
                确认解锁
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
