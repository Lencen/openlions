"use client";
/**
 * /system/settings —— 平台设置可视化中心（0.6.2 U-52，P0）
 *
 * 依据：[internal-doc] 01:23）
 *   边界：U-52 = 聚合入口页（目录 + 状态 + 跳转），**不重画 U-51 的编辑表单**；
 *        /system/model-config 的实现**不动**，只加入口与摘要。
 *   字段名：按与 [team] 定稿的 **agent_team**（设计 规格里的 team{} 是旧称，已报运营团队裁）。
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "unavailable";

interface AgentTeam { enabled: boolean; mode: string; turn_budget_seconds: number; long_task_threshold_seconds: number; overrides: Record<string, unknown> }

export default function SettingsCenterPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [team, setTeam] = useState<AgentTeam | null>(null);
  const [model, setModel] = useState<{ slots?: number; providers?: number; asOf?: string } | null>(null);
  // 0.6.3 U-49：平台语言（顶级键 team_language；与 sidecar check-team-language.cjs 同源）
  const [lang, setLang] = useState<string | null>(null);
  const [langBusy, setLangBusy] = useState(false);
  const [langErr, setLangErr] = useState("");

  const load = useCallback(async () => {
    setPhase("loading"); setErr("");
    try {
      const [ps, mc] = await Promise.all([
        fetch("/api/platform-settings", { cache: "no-store" }).catch(() => null),
        fetch("/api/model-config", { cache: "no-store" }).catch(() => null),
      ]);
      if (!ps || !ps.ok) { setErr("设置接口 " + (ps ? ps.status : "不可达")); setPhase("error"); return; }
      const pj = await ps.json().catch(() => null);
      if (!pj?.ok || !pj.settings?.agent_team) { setErr("设置不可得"); setPhase("unavailable"); return; }
      setTeam(pj.settings.agent_team);
      setLang(typeof pj.settings.team_language === "string" ? pj.settings.team_language : null);
      if (mc && mc.ok) {
        const mj = await mc.json().catch(() => null);
        if (mj?.ok) setModel({ slots: Array.isArray(mj.keys) ? mj.keys.length : undefined, providers: Array.isArray(mj.providers) ? mj.providers.length : undefined, asOf: mj.asOf });
      }
      setPhase("ok");
    } catch { setErr("请求失败"); setPhase("error"); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const na = (reason: string) => <span className={styles.na}>n/a <em>（{reason}）</em></span>;

  /** 0.6.3 U-49：切换平台语言（PATCH 顶级键 team_language；成功后回读） */
  const changeLang = useCallback(async (next: string) => {
    if (!next || next === lang || langBusy) return;
    setLangBusy(true); setLangErr("");
    try {
      const r = await fetch("/api/platform-settings", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ team_language: next }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) { setLangErr((j && j.error) || ("保存失败 " + r.status)); return; }
      setLang(j.settings && typeof j.settings.team_language === "string" ? j.settings.team_language : next);
    } catch { setLangErr("请求失败（网络/服务不可用）"); }
    finally { setLangBusy(false); }
  }, [lang, langBusy]);

  return (
    <main className="page" data-slot="system-settings-page">
      <PageHeader>
        <PageTitle>平台设置</PageTitle>
        <div className="page-subtitle">模型 / 团队 / 备份发布 统一入口。这里是「目录 + 状态」，具体编辑在各自页面（团队编辑见 /system/model-config）。</div>
      </PageHeader>

      {phase === "loading" && <div className={styles.state}>加载中…</div>}
      {phase === "error" && <div className={styles.state}><b>加载失败</b><p>{err}</p><button className="btn" onClick={load}>重试</button></div>}
      {phase === "unavailable" && <div className={styles.state}><b>设置不可得</b><p>{err}</p><button className="btn" onClick={load}>重试</button></div>}

      {phase === "ok" && (
        <div className={styles.groups} data-slot="system-settings-groups">
          {/* 分组① 模型配置 */}
          <section className={styles.group} aria-label="模型配置">
            <header className={styles.gHead}>
              <h2 className={styles.gTitle}>模型配置</h2>
              <span className={styles.badge + " " + (model?.slots ? styles.badgeOk : styles.badgeMute)}>
                {model?.slots ? "已配置 · " + model.slots + " 槽" : "未读取到"}
              </span>
            </header>
            <dl className={styles.kv}>
              <div><dt>已配置槽数</dt><dd>{model?.slots ? model.slots : na("接口未下发 keys")}</dd></div>
              <div><dt>供应商</dt><dd>{model?.providers ? model.providers : na("接口未下发 providers")}</dd></div>
              <div><dt>上次变更</dt><dd>{model?.asOf ? model.asOf : na("接口未下发 asOf")}</dd></div>
            </dl>
            <div className={styles.actions}><Link className="btn" href="/system/model-config">进入模型配置 →</Link></div>
          </section>

          {/* 分组② 平台语言（0.6.3 U-49；顶级键 team_language） */}
          <section className={styles.group} aria-label="平台语言">
            <header className={styles.gHead}>
              <h2 className={styles.gTitle}>平台语言</h2>
              <span className={styles.badge + " " + (lang ? styles.badgeOk : styles.badgeMute)}>
                {lang ? lang : "n/a"}
              </span>
            </header>
            <dl className={styles.kv}>
              <div><dt>当前语言</dt><dd>{lang ? (lang === "auto" ? "auto（跟随系统）" : lang) : na("设置不可得")}</dd></div>
              <div><dt>配置文件</dt><dd className={styles.mono}>~/.config/macs/platform-settings.json</dd></div>
              <div><dt>生效范围</dt><dd>团队跨线消息 / 文档 / 提交说明统一语言</dd></div>
            </dl>
            <div className={styles.actions}>
              {["auto", "zh-CN", "en-US"].map((v) => (
                <button key={v} type="button" className="btn" disabled={langBusy || lang === v}
                  aria-pressed={lang === v} onClick={() => changeLang(v)}>
                  {v === "auto" ? "跟随系统" : v === "zh-CN" ? "中文" : "English"}{lang === v ? "（当前）" : ""}
                </button>
              ))}
            </div>
            {langErr ? <p className={styles.err}>{langErr}</p> : null}
          </section>

          {/* 分组③ 智能体团队 / 全双工 */}
          <section className={styles.group} aria-label="智能体团队">
            <header className={styles.gHead}>
              <h2 className={styles.gTitle}>智能体团队 / 全双工</h2>
              <span className={styles.badge + " " + (team?.enabled ? styles.badgeWarn : styles.badgeMute)}>
                {team ? (team.enabled ? "已启用 · " + team.mode : "灰度安全 · 关闭") : "n/a"}
              </span>
            </header>
            <dl className={styles.kv}>
              <div><dt>总开关</dt><dd>{team ? (team.enabled ? "启用" : "关闭（灰度安全缺省）") : na("设置不可得")}</dd></div>
              <div><dt>运行模式</dt><dd>{team ? team.mode : na("设置不可得")}</dd></div>
              <div><dt>回合预算</dt><dd>{team ? team.turn_budget_seconds + " 秒" : na("设置不可得")}</dd></div>
              <div><dt>按线覆盖</dt><dd>{team ? Object.keys(team.overrides || {}).length + " 条" : na("设置不可得")}</dd></div>
            </dl>
            <div className={styles.actions}><Link className="btn" href="/system/model-config">进入团队设置 →</Link></div>
          </section>

          {/* 分组③ 备份 / 发布 */}
          <section className={styles.group} aria-label="备份与发布">
            <header className={styles.gHead}>
              <h2 className={styles.gTitle}>备份 / 发布</h2>
              <span className={styles.badge + " " + styles.badgeMute}>只读 + 触发</span>
            </header>
            <dl className={styles.kv}>
              <div><dt>最近备份时刻</dt><dd>{na("备份状态接口未纳入本批（见 U-35）")}</dd></div>
              <div><dt>备份大小</dt><dd>{na("同上")}</dd></div>
              <div><dt>最近发布版本</dt><dd>{na("同上")}</dd></div>
            </dl>
            <div className={styles.actions}>
              <button className="btn" disabled title="备份触发接口未纳入本批（U-35 负责）">查看备份</button>
              <button className="btn" disabled title="触发需二次确认，且接口未纳入本批">触发备份</button>
            </div>
            <p className={styles.hint}>本批只做入口与状态位；备份读写/触发属 U-35（devops），接口就绪后接。</p>
          </section>
        </div>
      )}
    </main>
  );
}