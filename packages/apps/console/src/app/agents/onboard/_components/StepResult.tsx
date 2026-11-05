"use client";
// agents/onboard 页 · Step 3 获取密钥 (从 page.tsx 抽出, 页面瘦身)
// 2026-10-15 钥匙治理(item 1): 注册**不再直发业务钥匙** —— 这里改为展示**一次性领取券**
//   (sk-claim-…, 默认 15 分钟、绑 agent_id、只能用一次), 并给出换取端点与命令;
//   已存在且明文仍在 1 小时窗口内的服务仍会显示沿用来的 api_key(兼容旧行为)。
// 2026-10-15 文案业务化: 给用户看的说明一律走 i18n 业务语言(一次性领取券 / 正式钥匙 / 领取后有效 /
//   换过作废), 端点与命令**原文**收进"查看命令"折叠区(<details>+<pre>, 与 flywheel/lineage 页既有做法一致)
//   —— 既不把内部术语写在正文, 也不删掉装机人需要的可执行细节(仍可原样复制)。
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零（改由 StepResult.module.css 的类承载）。
//   文案、i18n key、命令原文与回调一字未改。
import { t } from "@/i18n";
import type { OnboardForm } from "./types";
import styles from "./StepResult.module.css";

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
    <section className={styles.wrap}>
      <h2 className={styles.title}>
        {ticket ? t('onboard.result.title.ticket') : t('onboard.result.title.plain')}
      </h2>
      <p className={styles.lead}>
        {ticket
          ? t('onboard.result.note.ticket', { agent: form.agent_id, ttl: ttlMinutes })
          : t('onboard.result.note.plain', { agent: form.agent_id })}
      </p>

      {ticket && (
        <div className={styles.card + " " + styles.cardPrimary}>
          <div className={styles.rowBetween + " " + styles.mb15}>
            <span className={styles.strongMd}>{t('onboard.result.ticket.heading')}</span>
            <span className={styles.metaSm}>
              {t('onboard.result.ticket.meta', { expiresAt: ticket.expires_at, ttl: ttlMinutes, hash8: ticket.hash8 })}
            </span>
          </div>
          <div className={styles.rowFlex + " " + styles.mb2}>
            <code className={styles.codeLine}>
              {ticket.value}
            </code>
            <button onClick={() => navigator.clipboard.writeText(ticket.value)}
              className={styles.copyBtn}>
              {t('onboard.result.ticket.copy')}
            </button>
          </div>
          <div className={styles.metaSm + " " + styles.mb15}>
            {t('onboard.result.ticket.coverage', { services: (ticket.services || []).join(", ") || t('common.none') })}
          </div>
          <div className={styles.metaSm}>
            {t('onboard.result.ticket.installer')}
          </div>
          {/* 2026-10-15 文案业务化: 两条命令是**给装机人的原文**(可原样复制), 放折叠区; 正文只讲业务语言。 */}
          <details className={styles.details}>
            <summary className={styles.summary}>{t('onboard.result.ticket.commandSummary')}</summary>
            <pre className={styles.pre}>
{`curl -X POST <MIND>/api/v1/agent/claim-service-key \\
  -H 'Content-Type: application/json' \\
  -d '{"agent_id":"${form.agent_id}","ticket":"${ticket.value}"}'`}
            </pre>
          </details>
          <details className={styles.details}>
            <summary className={styles.summary}>{t('onboard.result.ticket.installerCommandSummary')}</summary>
            <pre className={styles.pre}>
{`MCP_API_KEY=${ticket.value} ./install-agent.sh ${form.agent_id}`}
            </pre>
            <div className={styles.metaSm + " " + styles.mt1}>
              {t('onboard.result.ticket.commandHint')}
            </div>
          </details>
        </div>
      )}

      {services.length > 0 && (
        <div className={styles.card}>
          {services.map(([name, s]: [string, any]) => (
            <div key={name} className={styles.serviceRow}>
              <div className={styles.rowBetween + " " + styles.mb1}>
                <span className={styles.strongMd}>{name}</span>
                <span
                  className={styles.metaSm}
                  data-tone={s.status === "idempotent_reused" || s.status === "registered" ? "ok" : undefined}
                >{statusLabel(s.status)}</span>
              </div>
              {s.api_key ? (
                <div className={styles.rowFlex}>
                  <code className={styles.codeLine}>
                    {s.api_key}
                  </code>
                  <button onClick={() => navigator.clipboard.writeText(s.api_key)}
                    className={styles.copyBtn}>
                    复制
                  </button>
                </div>
              ) : (
                <div className={styles.baseMuted}>
                  {s.status === "claim_required" ? t('onboard.result.service.claimRequired') : t('onboard.result.service.noKey')}
                </div>
              )}
              <div className={styles.metaSm + " " + styles.mt05}>
                接口地址：{s.endpoint} · 权限：{(s.permissions || []).join(", ")}
                {s.expires_at ? ` · 有效期至 ${s.expires_at}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={styles.actions}>
        <button onClick={onCopyEnv}
          className={styles.btnGhost}>
          复制 .env 格式
        </button>
        <button onClick={onRestart}
          className={styles.btnPrimary}>
          注册新智能体
        </button>
      </div>
    </section>
  );
}
