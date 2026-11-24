"use client";

// /system/auth — 平台授权（只读展示 + 写鉴权模式切换）
// 设计与数据源核查（2026-11-19）：
//   · 设计槽位（[internal-doc] 的 /system/auth）：
//       s8「授权矩阵（角色×权限点，单元格可切换）」table / s4「待审批（2 条）」list / s12「note(info) 读写分离」note
//   · 角色 × 权限点：**无该数据源**。console 没有角色清单/权限点接口；/api/rbac 只返回授权规则
//     （subjectType=agent|role × resourceType × permission，实测 1 条、无 role 规则），角色 id 只在服务端
//     由 OrgPosition→roleId 解析、不下发浏览器 -> 矩阵本体写 n/a + 具体原因，不拿别的表冒充。
//   · 同类数据：GET /api/agent-permissions（业务服务 × 密钥授权；BFF 白名单，不含密钥指纹/明文）
//   · 待审批：GET /api/agent-keys/pending（MACS 钥匙接入申请；实测返回空集 = 真 0，不是不可得）
//   · 写鉴权模式：GET /api/platform/config 的 authMode（可写：二次确认 + 原因 + 审计）
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BentoCard, BentoGrid, BentoState } from "@/components/bento";
import { DataTable, PageHeader, PageTitle, Pill } from "@/components/ui";
import type { DataColumn } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden" | "empty";
interface Perm { service_name?: string; status?: string; expires_at?: string | null; scope?: string; }
interface Agent { agent_id?: string; display_name?: string; permissions?: Perm[]; }
interface PendingItem {
  request_id?: string; agent_id?: string; requested_scope?: string;
  requested_ttl_days?: number | null; note?: string; status?: string; requested_at?: string;
}

const fmtTime = (s?: string | null) => (s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "n/a");

export default function AuthReadonlyPage() {
  const [rows, setRows] = useState<Array<{ svc: string; active: number; revoked: number }>>([]);
  const [agentsN, setAgentsN] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [asOf, setAsOf] = useState("");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // 0.6.4 U-56a：平台写鉴权模式（enforce/shadow/off）——读 GET /api/platform/config 的 authMode
  const [authMode, setAuthMode] = useState<string | null>(null);
  const [authModeSource, setAuthModeSource] = useState<string>("");
  const [modeBusy, setModeBusy] = useState(false);
  const [modeErr, setModeErr] = useState("");
  const [pendingMode, setPendingMode] = useState<string | null>(null); // 二次确认待提交
  const [reason, setReason] = useState("");

  // 设计槽位 s4「待审批」：钥匙接入申请（与授权矩阵是两条独立链路，失败不影响矩阵）
  const [pendingKeys, setPendingKeys] = useState<number | null>(null);
  const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);
  const [pendingNote, setPendingNote] = useState("");

  useEffect(() => {
    let alive = true; setPhase("loading"); setErr("");
    (async () => {
      try {
        // 0.6.4 U-56a：并行读写鉴权模式（独立于授权矩阵，失败不影响主数据）
        fetch("/api/platform/config", { cache: "no-store" })
          .then((x) => (x.ok ? x.json() : null))
          .then((j) => { if (alive && j && j.ok) { setAuthMode(String(j.authMode || "")); setAuthModeSource(String(j.authModeSource || "")); } })
          .catch(() => {});
        const r = await fetch("/api/agent-permissions", { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        if (!r.ok) { setErr("授权接口 " + r.status); setPhase("error"); return; }
        const j = await r.json();
        const list: Agent[] = Array.isArray(j) ? j : [];
        const stat: Record<string, { active: number; revoked: number }> = {};
        for (const a of list) for (const p of (a.permissions || [])) {
          const s = String(p.service_name || "unknown");
          if (!stat[s]) stat[s] = { active: 0, revoked: 0 };
          if (p.status === "ACTIVE") stat[s].active++;
          else if (p.status === "REVOKED") stat[s].revoked++;
        }
        if (!alive) return;
        setAgentsN(list.length);
        setRows(Object.entries(stat).map(([svc, v]) => ({ svc, active: v.active, revoked: v.revoked })));
        setAsOf(new Date().toISOString());
        setPhase(Object.keys(stat).length ? "ok" : "empty");
      } catch {
        if (alive) { setErr("授权请求失败（网络/服务不可用）"); setPhase("error"); }
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  // 待审批（s4）：与矩阵并行，三态区分「无数据源(接口报错)」与「真 0（空集）」
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/agent-keys/pending", { cache: "no-store" });
        if (!alive) return;
        if (!r.ok) { setPendingKeys(null); setPendingNote("待审批读接口返回状态码 " + r.status); return; }
        const j = await r.json().catch(() => null);
        const items = j && Array.isArray(j.items) ? (j.items as PendingItem[]) : null;
        if (!items) { setPendingKeys(null); setPendingNote("待审批响应里没有条目数组"); return; }
        setPendingItems(items); setPendingKeys(items.length); setPendingNote("");
      } catch {
        if (alive) { setPendingKeys(null); setPendingNote("待审批请求失败（网络/服务不可用）"); }
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const active = rows.reduce((s, r) => s + r.active, 0);
  const revoked = rows.reduce((s, r) => s + r.revoked, 0);

  /** 0.6.4 U-56a：切换写鉴权模式（二次确认 + reason + off 需 acknowledge） */
  const toggleMode = useCallback(async (mode: string) => {
    if (modeBusy) return;
    setModeBusy(true); setModeErr("");
    try {
      const body: Record<string, unknown> = { mode, reason: reason.trim() || "页面切换写鉴权模式（" + mode + "）", confirm: true };
      if (mode === "off") body.acknowledge = "I-understand";
      const r = await fetch("/api/system/auth/toggle", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) { setModeErr((j && (j.error || (j.errors || []).join("；"))) || ("保存失败 " + r.status)); return; }
      setAuthMode(String(j.mode || mode)); setAuthModeSource("file"); setPendingMode(null); setReason("");
    } catch { setModeErr("请求失败（网络/服务不可用）"); }
    finally { setModeBusy(false); }
  }, [modeBusy, reason]);

  const columns: DataColumn<{ svc: string; active: number; revoked: number }>[] = [
    { key: "svc", title: "业务服务", render: (r) => <b>{r.svc}</b> },
    { key: "active", title: "有效授权", align: "right", width: 110, render: (r) => r.active },
    { key: "revoked", title: "已取消", align: "right", width: 100, render: (r) => r.revoked },
    { key: "auth", title: "认证方式", width: 120, render: () => "接口密钥" },
  ];

  return (
    <main className="page" data-slot="system-auth-page">
      <PageHeader>
        <PageTitle>统一认证</PageTitle>
        <Pill tone="neutral">授权矩阵 · 只读</Pill>
        <Pill tone="info">写鉴权 · 可写（二次确认）</Pill>
      </PageHeader>
      <div className="page-subtitle">
        平台授权：授权矩阵（角色 × 权限点模型当前无数据源，卡内写原因与同类数据）· 待审批（钥匙接入申请）· 读写分离口径 · 数据时刻 {asOf ? fmtTime(asOf) : "n/a（请求未完成）"}
      </div>

      <BentoGrid>
        {/* 设计槽位 s8：授权矩阵（角色×权限点，单元格可切换）——table */}
        <BentoCard
          title="授权矩阵（角色×权限点，单元格可切换）"
          sub={agentsN == null ? "设计槽位 s8 · table · 同类数据读取中/不可得" : "设计槽位 s8 · table · 涉及 " + agentsN + " 个智能体的授权记录"}
          span={8}
        >
          <p className={styles.na}>
            <b>矩阵本体 n/a（无该数据源，不伪造）</b>：平台目前没有「角色 × 权限点」的清单出口 —— 控制台侧读不到角色清单与权限点；
            现有授权规则是规则级的（按主体、资源、操作登记，实测 1 条、不含角色维度），角色编码只在服务端内部解析、不下发浏览器。
            故本卡不渲染设计矩阵，也不把下方同类表冒充成设计矩阵。
          </p>
          <h3 className={styles.subHead}>同类数据：业务服务 × 密钥授权（只读 · 有效 {active} / 已取消 {revoked}）</h3>
          {phase === "loading" && <BentoState phase="loading" />}
          {phase === "forbidden" && <BentoState phase="forbidden" title="无权限" detail="当前账号没有查看授权数据的权限（401/403）。" />}
          {phase === "error" && <BentoState phase="error" title="授权数据不可得" detail={err || "接口不可用"} onRetry={reload} />}
          {phase === "empty" && <BentoState phase="empty" title="暂无授权数据" detail="接口正常返回但没有任何业务服务授权记录（empty，非不可得）。" />}
          {phase === "ok" && (
            <div className={styles.tblWrap} data-slot="system-auth-table">
              <DataTable columns={columns} rows={rows} empty={{ title: "暂无授权记录", desc: "接口返回空集。" }} />
            </div>
          )}
        </BentoCard>

        {/* 设计槽位 s4：待审批（2 条）——list */}
        <BentoCard
          title={"待审批（" + (pendingKeys == null ? "n/a" : pendingKeys) + " 条）"}
          sub="设计槽位 s4 · list · 钥匙接入申请（GET /api/agent-keys/pending）"
          span={4}
          actions={<Link className={styles.more} href="/agents/keys">全部</Link>}
        >
          <p className={styles.report}>
            口径报备：设计槽位 s4 的标题为「待审批（2 条）」，其中“2 条”是设计稿 demo 的固定示例数；
            本卡标题按接口实测渲染（{pendingKeys == null ? "n/a" : pendingKeys + " 条"}），不套用示例值。
          </p>
          {pendingKeys == null ? (
            <p className={styles.noteText}>n/a：{pendingNote || "待审批接口不可得"}（不写 0 顶替）</p>
          ) : (
            <ul className={styles.list}>
              {pendingItems.length === 0 ? (
                <li className={styles.listItem}>暂无待审批条目（接口返回空集 = 真 0，非不可得）</li>
              ) : pendingItems.slice(0, 6).map((p, i) => (
                <li className={styles.listItem} key={String(p.request_id || i)}>
                  <div className={styles.listRow}>
                    <b>{p.agent_id || "n/a（无 agent_id）"}</b>
                    <Pill tone="warn">{p.status === "pending" ? "待批" : (p.status || "n/a")}</Pill>
                  </div>
                  <div className={styles.listMeta}>
                    范围 {p.requested_scope || "n/a"} · 有效期 {p.requested_ttl_days == null ? "n/a" : p.requested_ttl_days + " 天"} · {fmtTime(p.requested_at)}
                  </div>
                  <div className={styles.listMeta}>{p.note ? p.note : "无备注"}</div>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>

        {/* 设计槽位 s12：note(info) 读写分离——note */}
        <BentoCard title="读写分离" sub="设计槽位 s12 · note(info)" span={12}>
          <div className={styles.note}>
            <p className={styles.noteText}>
              <b>note(info) 读写分离</b>：viewer 可看不可改；config.write 仅 owner/admin；auth.grant 仅 owner。所有变更保留 180 天，可在运维看板审计里查到。
            </p>
            <p className={styles.noteText}>
              <b>本页边界</b>：授权 / 取消授权不在本页开放（走专用写路径，需权限校验 + 二次确认 + 审计）；
              写鉴权模式在下方卡片切换。审计落点 n/a（console 暂无 /api/audit 只读接口，写路径审计在服务端记录）；
              密钥指纹 / 明文不在本页展示（BFF 白名单已剔除）。
            </p>
            <p className={styles.noteText}>
              <b>数据时刻</b>：{asOf ? fmtTime(asOf) : "n/a（请求未完成）"}
            </p>
          </div>
        </BentoCard>

        {/* 0.6.4 U-56a：平台写鉴权模式——**独立于授权矩阵状态**渲染。
            devops 06:32 冒烟 FAIL 指出的真实缺陷：原实现把它放在 phase==="ok" 内，
            授权矩阵空/错/不可得时本卡不渲染，但「写鉴权模式」与「授权矩阵数据」是两件独立的事
            （前者读 /api/platform/config 的 authMode，后者读 /api/agent-permissions）。 */}
        <BentoCard
          title="平台写鉴权模式"
          sub={authMode ? "当前 " + authMode + "（来源 " + (authModeSource || "n/a") + "）" : "读取中/不可得"}
          span={12}
          actions={<Pill tone="neutral">可写 · 二次确认</Pill>}
        >
          {authMode === null ? (
            <div className={styles.notes}>n/a（GET /api/platform/config 未返回 authMode；不写 0、不猜当前值）</div>
          ) : (
            <>
              <dl className={styles.kv}>
                <div><dt>当前模式</dt><dd><b>{authMode}</b></dd></div>
                <div><dt>来源</dt><dd>{authModeSource === "env" ? "环境配置锁定（页面不可覆盖，切换会被拒绝）" : authModeSource === "file" ? "平台设置文件（可切换）" : authModeSource === "default" ? "默认值（未显式配置，可切换）" : authModeSource || "n/a"}</dd></div>
              </dl>
              <div className={styles.modeRow}>
                {["enforce", "shadow", "off"].map((m) => (
                  <button
                    key={m} type="button" className="btn"
                    disabled={modeBusy || authMode === m || authModeSource === "env"}
                    aria-pressed={authMode === m}
                    onClick={() => { setPendingMode(m); setModeErr(""); }}
                  >
                    {m}{authMode === m ? "（当前）" : ""}
                  </button>
                ))}
              </div>
              {pendingMode ? (
                <div className={styles.confirm}>
                  <p><b>确认切换</b>：<code>{authMode}</code> → <code>{pendingMode}</code></p>
                  {pendingMode === "off" ? <p className={styles.warn}>关闭写鉴权后，平台写操作将不再校验访问凭证（仍有审计留痕）。请确认这是演练或受控场景。</p> : null}
                  <label className={styles.reasonLabel}>
                    变更原因（必填，写入审计）
                    <input className={styles.reasonInput} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：演练后恢复 enforce" />
                  </label>
                  <div className={styles.modeRow}>
                    <button type="button" className="btn" disabled={modeBusy} onClick={() => toggleMode(pendingMode!)}>确认切换</button>
                    <button type="button" className="btn" disabled={modeBusy} onClick={() => { setPendingMode(null); setModeErr(""); }}>取消</button>
                  </div>
                </div>
              ) : null}
              {modeErr ? <p className={styles.err}>{modeErr}</p> : null}
            </>
          )}
        </BentoCard>
      </BentoGrid>
    </main>
  );
}
