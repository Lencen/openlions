"use client";
// agents/onboard 页 · Step 3 获取密钥 (从 page.tsx 抽出, 页面瘦身)
// 2026-10-15 钥匙治理(item 1): 注册**不再直发业务钥匙** —— 这里改为展示**一次性领取券**
//   (sk-claim-…, 默认 15 分钟、绑 agent_id、只能用一次), 并给出换取端点与命令;
//   已存在且明文仍在 1 小时窗口内的服务仍会显示沿用来的 api_key(兼容旧行为)。
// 2026-10-15 文案业务化: 给用户看的说明一律走 i18n 业务语言(一次性领取券 / 正式钥匙 / 领取后有效 /
//   换过作废), 端点与命令**原文**收进"查看命令"折叠区(<details>+<pre>, 与 flywheel/lineage 页既有做法一致)
//   —— 既不把内部术语写在正文, 也不删掉装机人需要的可执行细节(仍可原样复制)。
import { t } from "@/i18n";
import type { OnboardForm } from "./types";

/** 服务条目状态 -> 人读文案(2026-10-15 起 register 的状态集合变了) */
function statusLabel(s: string | undefined): string {
  switch (s) {
    case "claim_required": return t('onboard.result.status.claimRequired');
    case "idempotent_reused": return t('onboard.result.status.reusedExisting');
    case "registered": return t('onboard.result.status.issued');
    case "repaired": return t('onboard.result.status.repaired');
    case "skipped": return t('onboard.result.status.skipped');
    case "failed": return t('onboard.result.status.failed');
    default: return s || "";
  }
}

export default function StepResult({
  result,
  form,
  onCopyEnv,
  onRestart,
}: {
  result: any;
  form: OnboardForm;
  onCopyEnv: () => void;
  onRestart: () => void;
}) {
  const ticket = result?.claim_ticket;
  const services = Object.entries(result.services || {}) as [string, any][];
  // 券有效期由服务端给(ticket.ttl_seconds), 页面只说"领取后 N 分钟内有效", 不写死 15 分钟。
  const ttlMinutes = Math.max(1, Math.round(Number(ticket?.ttl_seconds || 0) / 60) || 15);
  return (
    <section style={{ maxWidth: 640 }}>
      <h2 style={{ fontSize: "var(--fs-xl)", marginBottom: "var(--sp-2)" }}>
        {ticket ? t('onboard.result.title.ticket') : t('onboard.result.title.plain')}
      </h2>
      <p style={{ fontSize: "var(--fs-md)", color: "var(--text-muted)", marginBottom: "var(--sp-4)" }}>
        {ticket
          ? t('onboard.result.note.ticket', { agent: form.agent_id, ttl: ttlMinutes })
          : t('onboard.result.note.plain', { agent: form.agent_id })}
      </p>

      {ticket && (
        <div style={{ padding: "var(--sp-4)", borderRadius: "var(--radius-md)", background: "var(--bg-surface)", border: "1px solid var(--primary)", marginBottom: "var(--sp-4)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--sp-1-5)" }}>
            <span style={{ fontWeight: 600, fontSize: "var(--fs-md)" }}>{t('onboard.result.ticket.heading')}</span>
            <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>
              {t('onboard.result.ticket.meta', { expiresAt: ticket.expires_at, ttl: ttlMinutes, hash8: ticket.hash8 })}
            </span>
          </div>
          <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", marginBottom: "var(--sp-2)" }}>
            <code style={{ fontSize: "var(--fs-base)", padding: "var(--sp-1) var(--sp-2)", borderRadius: "var(--radius-xs)", background: "var(--bg)", color: "var(--primary)", flex: 1, wordBreak: "break-all" }}>
              {ticket.value}
            </code>
            <button onClick={() => navigator.clipboard.writeText(ticket.value)}
              style={{ padding: "var(--sp-1) var(--sp-2)", fontSize: "var(--fs-sm)", borderRadius: "var(--radius-xs)", cursor: "pointer", background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)" }}>
              {t('onboard.result.ticket.copy')}
            </button>
          </div>
          <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", marginBottom: "var(--sp-1-5)" }}>
            {t('onboard.result.ticket.coverage', { services: (ticket.services || []).join(", ") || t('common.none') })}
          </div>
          <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>
            {t('onboard.result.ticket.installer')}
          </div>
          {/* 2026-10-15 文案业务化: 两条命令是**给装机人的原文**(可原样复制), 放折叠区; 正文只讲业务语言。 */}
          <details style={{ marginTop: "var(--sp-1-5)" }}>
            <summary style={{ cursor: "pointer", fontSize: "var(--fs-sm)" }}>{t('onboard.result.ticket.commandSummary')}</summary>
            <pre style={{ fontSize: "var(--fs-sm)", padding: "var(--sp-2)", borderRadius: "var(--radius-sm)", background: "var(--bg)", overflowX: "auto", margin: "var(--sp-1-5) 0 0" }}>
{`curl -X POST <MIND>/api/v1/agent/claim-service-key \\
  -H 'Content-Type: application/json' \\
  -d '{"agent_id":"${form.agent_id}","ticket":"${ticket.value}"}'`}
            </pre>
          </details>
          <details style={{ marginTop: "var(--sp-1-5)" }}>
            <summary style={{ cursor: "pointer", fontSize: "var(--fs-sm)" }}>{t('onboard.result.ticket.installerCommandSummary')}</summary>
            <pre style={{ fontSize: "var(--fs-sm)", padding: "var(--sp-2)", borderRadius: "var(--radius-sm)", background: "var(--bg)", overflowX: "auto", margin: "var(--sp-1-5) 0 0" }}>
{`MCP_API_KEY=${ticket.value} ./install-agent.sh ${form.agent_id}`}
            </pre>
            <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", marginTop: "var(--sp-1)" }}>
              {t('onboard.result.ticket.commandHint')}
            </div>
          </details>
        </div>
      )}

      {services.length > 0 && (
        <div style={{ padding: "var(--sp-4)", borderRadius: "var(--radius-md)", background: "var(--bg-surface)", border: "1px solid var(--border)", marginBottom: "var(--sp-4)" }}>
          {services.map(([name, s]: [string, any]) => (
            <div key={name} style={{ marginBottom: "var(--sp-3)", paddingBottom: "var(--sp-3)", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--sp-1)" }}>
                <span style={{ fontWeight: 600, fontSize: "var(--fs-md)" }}>{name}</span>
                <span style={{ fontSize: "var(--fs-sm)", color: s.status === "idempotent_reused" || s.status === "registered" ? "var(--status-ok)" : "var(--text-muted)" }}>{statusLabel(s.status)}</span>
              </div>
              {s.api_key ? (
                <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center" }}>
                  <code style={{ fontSize: "var(--fs-base)", padding: "var(--sp-1) var(--sp-2)", borderRadius: "var(--radius-xs)", background: "var(--bg)", color: "var(--primary)", flex: 1, wordBreak: "break-all" }}>
                    {s.api_key}
                  </code>
                  <button onClick={() => navigator.clipboard.writeText(s.api_key)}
                    style={{ padding: "var(--sp-1) var(--sp-2)", fontSize: "var(--fs-sm)", borderRadius: "var(--radius-xs)", cursor: "pointer", background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)" }}>
                    复制
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: "var(--fs-base)", color: "var(--text-muted)" }}>
                  {s.status === "claim_required" ? t('onboard.result.service.claimRequired') : t('onboard.result.service.noKey')}
                </div>
              )}
              <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", marginTop: "var(--sp-0-5)" }}>
                接口地址：{s.endpoint} · 权限：{(s.permissions || []).join(", ")}
                {s.expires_at ? ` · 有效期至 ${s.expires_at}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <button onClick={onCopyEnv}
          style={{ padding: "var(--sp-2-5) var(--sp-5)", borderRadius: "var(--radius-md)", fontSize: "var(--fs-lg)", cursor: "pointer", background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)" }}>
          复制 .env 格式
        </button>
        <button onClick={onRestart}
          style={{ padding: "var(--sp-2-5) var(--sp-5)", borderRadius: "var(--radius-md)", fontSize: "var(--fs-lg)", cursor: "pointer", background: "var(--primary)", color: "var(--on-primary)", border: "none" }}>
          注册新智能体
        </button>
      </div>
    </section>
  );
}
