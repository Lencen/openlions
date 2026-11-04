"use client";
// 守门详情抽屉 — 守门规则管理页面 (#3) 用
// 2026-09-24: 与 CognitiveDetailDrawer 同模式 (侧边抽屉, 不离开列表)。
// 展示 4 段:①基础信息(层/触发/源码位置) ②复算命令(可复制) ③最近一次跑的结果(从 service-check 拉)
//           ④关联事件/告警(FlywheelEvent) ⑤出处 PR(git log)
//
// 只读 — 不引入可写配置; 与 SSOT(guard-registry.json = 源码投影)保持单向。
import { useLazyApi } from "@/lib/api";
import { Drawer } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";

interface GuardDetailResp {
  guard: { id: string; layer: string; name: string; file: string; line: number; trigger: string; action: string; note: string; recompute: string };
  layer: { id: string; name: string; desc: string; trigger: string; count: number } | null;
  registry: { generatedAt: string; fingerprint: string };
  lastRun: { ok: boolean; detail: string; serviceCheckAt: string } | null;
  events: Array<{ id: string; type: string; source: string; message: string; createdAt: number; createdAtText: string }>;
  provenance: Array<{ hash: string; subject: string; author: string; date: string }>;
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", padding: "var(--sp-1) 0", fontSize: "var(--fs-base)", borderBottom: "1px solid var(--border)" }}>
      <div style={{ width: 96, color: "var(--text-dim)", flexShrink: 0 }}>{label}</div>
      <div className={mono ? "mono" : ""} style={{ wordBreak: "break-all", flex: 1 }}>{value}</div>
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  return (
    <button type="button" className="badge" style={{ marginLeft: "var(--sp-1-5)", cursor: "pointer" }}
      onClick={() => { try { navigator.clipboard.writeText(text); } catch {} }}
      title="复制">📋</button>
  );
}

export default function GuardDetailDrawer({
  id,
  open,
  onClose,
}: {
  id: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const path = id ? `/api/guards/${encodeURIComponent(id)}` : null;
  const { data, loading, error } = useLazyApi<GuardDetailResp>(path);

  return (
    <Drawer open={open} onClose={onClose} width={580} title={data?.guard ? `守门详情 · ${data.guard.name}` : "守门详情"}>
      {loading && <div style={{ padding: "var(--sp-3)", color: "var(--text-dim)", fontSize: "var(--fs-base)" }}>加载中…</div>}

      {!loading && error && (
        <div style={{ padding: "var(--sp-3)", color: "var(--status-crit)", fontSize: "var(--fs-base)" }}>守门详情加载失败: {String((error as Error)?.message || error)}</div>
      )}

      {!loading && !error && !data && (
        <div style={{ padding: "var(--sp-3)", color: "var(--status-crit)", fontSize: "var(--fs-base)" }}>守门 `{id}` 不存在或详情不可读</div>
      )}

      {!loading && data && (<>
        {/* 1. 基础信息 */}
        <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, marginBottom: "var(--sp-2)", color: "var(--text)" }}>① 基础信息</div>
        <Row label="守门编号" value={data.guard.id} mono />
        <Row label="层" value={`${data.guard.layer} · ${data.layer?.name ?? "?"}`} />
        <Row label="名称" value={data.guard.name} />
        <Row label="触发" value={data.guard.trigger} />
        {data.guard.note && <Row label="说明" value={data.guard.note} />}

        {/* 2. 复算命令(可复制) */}
        <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, margin: "var(--sp-4) 0 var(--sp-2)", color: "var(--text)" }}>② 复算命令</div>
        <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-xs)", padding: "var(--sp-2)", fontSize: "var(--fs-sm)", fontFamily: "var(--font-mono, monospace)", position: "relative" }}>
          <div style={{ wordBreak: "break-all", whiteSpace: "pre-wrap" }}>{data.guard.recompute || `(暂无复算命令; 源码位置 ${data.guard.file}:${data.guard.line})`}</div>
          <div style={{ position: "absolute", top: 6, right: 6 }}>
            <CopyBtn text={data.guard.recompute || `${data.guard.file}:${data.guard.line}`} />
          </div>
        </div>

        {/* 3. 最近一次跑的结果 */}
        <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, margin: "var(--sp-4) 0 var(--sp-2)", color: "var(--text)" }}>③ 最近一次跑的结果</div>
        {data.lastRun ? (
          <div style={{
            // 2026-10-13 round 76-DC: 原来是**旧调色板**的字面量(旧绿 16,185,129 / 旧红 239,68,68)且不跟随主题 -> 从状态令牌派生。
            background: data.lastRun.ok ? "color-mix(in srgb, var(--status-ok) 8%, transparent)" : "color-mix(in srgb, var(--status-crit) 8%, transparent)",
            border: `1px solid ${data.lastRun.ok ? "color-mix(in srgb, var(--status-ok) 40%, transparent)" : "color-mix(in srgb, var(--status-crit) 40%, transparent)"}`,
            borderRadius: "var(--radius-xs)", padding: "var(--sp-2-5)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", marginBottom: "var(--sp-1-5)" }}>
              <span className="badge" style={{ background: data.lastRun.ok ? "var(--status-ok)" : "var(--status-crit)", color: "var(--on-accent)" }}>
                {data.lastRun.ok ? "✓ PASS" : "✗ FAIL"}
              </span>
              <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{data.lastRun.serviceCheckAt.replace("T", " ").slice(0, 19)}</span>
            </div>
            <div style={{ fontSize: "var(--fs-base)", wordBreak: "break-all" }}>{data.lastRun.detail}</div>
          </div>
        ) : (
          <div style={{ padding: "var(--sp-2)", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-xs)", fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>
            此守门未被 service-check-5h 直接覆盖(名字未出现在 checks[] 中)。
            <br />它可能是:①提交前 (L1 pre-commit) ②验收判据 (L3 spec 在 acceptance runner 中跑) ③运行期门禁 (L4 内联调用) ④单点文档 (L5 人工阅读)。
            <br />复算请按 ② 段的命令手动跑。
          </div>
        )}

        {/* 4. 关联事件 / 告警 */}
        <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, margin: "var(--sp-4) 0 var(--sp-2)", color: "var(--text)" }}>④ 关联事件 / 告警 (平台事件流, 最近 5 条)</div>
        {data.events.length === 0 ? (
          <div style={{ padding: "var(--sp-2)", fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>暂无事件</div>
        ) : (
          <>
          <TableCopyButton />
          <table className="tbl" style={{ fontSize: "var(--fs-sm)" }}>
            <thead><tr><th style={{ width: 130 }}>时间</th><th style={{ width: 80 }}>类型</th><th>消息</th></tr></thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap mono">{e.createdAtText}</td>
                  <td className="nowrap">{e.type}</td>
                  <td style={{ wordBreak: "break-all" }}>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}

        {/* 5. 出处 PR */}
        <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, margin: "var(--sp-4) 0 var(--sp-2)", color: "var(--text)" }}>⑤ 出处 (最近 5 个改动该源码文件的 commit)</div>
        <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", marginBottom: "var(--sp-1-5)" }}>文件: <span className="mono">{data.guard.file}:{data.guard.line}</span></div>
        {data.provenance.length === 0 ? (
          <div style={{ padding: "var(--sp-2)", fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>git 不可达或文件无变更历史</div>
        ) : (
          <div>
            {data.provenance.map((p) => (
              <div key={p.hash} style={{ padding: "var(--sp-1) 0", borderBottom: "1px dashed var(--border)", fontSize: "var(--fs-sm)" }}>
                <span className="mono" style={{ color: "var(--primary)" }}>{p.hash}</span>
                <span style={{ marginLeft: "var(--sp-2)", color: "var(--text-dim)" }}>{p.date} · {p.author}</span>
                <div style={{ marginTop: "var(--sp-0-5)" }}>{p.subject}</div>
              </div>
            ))}
          </div>
        )}

        {/* footer 信息 */}
        <div style={{ marginTop: "var(--sp-4)", padding: "var(--sp-2) 0", borderTop: "1px solid var(--border)", fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
          总表生成于 {data.registry.generatedAt.replace("T", " ").slice(0, 19)} · fingerprint <span className="mono">{data.registry.fingerprint.slice(0, 12)}…</span>
          <br />防漂移: <span className="mono">node scripts/guard-registry.cjs --check</span>
        </div>
      </>)}
    </Drawer>
  );
}
