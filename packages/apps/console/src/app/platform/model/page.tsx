"use client";
// 「模型配置」——用户自带 key（路线图 §1.2）。保存写各 app 的 .env(0600)，重启 mind/selfimproving 生效。
// 2026-11-05 P2 呈现层（批8）：内联 style 清零。
//   表单字号/行距、字段行栅格、字段名宽度、输入框 flex、保存按钮与提示的间距、
//   底部出链行下沉到本目录 page.module.css（追加，原有 .crumbDim 未动）。取数与保存逻辑未动。
import { useEffect, useState } from "react";
import Link from "next/link";
import { Pill, PanelCard } from "@/components/ui";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

const FIELDS: Array<{ key: string; label: string; hint: string }> = [
  { key: "ANTHROPIC_BASE_URL", label: "Base URL", hint: "兼容 Anthropic 协议；自部署/中转填这里" },
  { key: "ANTHROPIC_AUTH_TOKEN", label: "访问密钥", hint: "你自己的 key；保存后不显示明文" },
  { key: "ANTHROPIC_MODEL", label: "模型名", hint: "如 claude-* / MiniMax 模型名" },
  { key: "MINIMAX_API_KEY", label: "MiniMax Key", hint: "走 MiniMax 原生 key 时填" },
  { key: "REFLECT_MODEL", label: "反思模型", hint: "可空，空则用默认模型" },
];

interface GetResp { ok?: boolean; masked?: Record<string, string>; configured?: string[] }

export default function ModelConfigPage() {
  const [masked, setMasked] = useState<Record<string, string>>({});
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch("/api/model-config")
      .then((r) => r.json())
      .then((d: GetResp) => { setMasked(d.masked || {}); setLoading(false); })
      .catch(() => { setMsg("读取失败"); setLoading(false); });
  }, []);
  const save = async () => {
    setMsg("保存中…");
    try {
      const r = await fetch("/api/model-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      setMsg(j.ok ? "已保存。重启 mind / selfimproving 后生效。" : "保存失败：" + (j.error || "未知错误"));
    } catch (e) {
      setMsg("保存失败：" + String(e));
    }
  };
  return (
    <main className="page">
      <div className="breadcrumb"><span className={styles.crumbDim}>平台</span><span className="sep">/</span><span className="current">模型配置</span></div>
      <PageHeader>
        <PageTitle>模型配置</PageTitle>
        <div className="page-subtitle">模型供应商、路由与限额</div>
        <div className="hero-tags"><Pill tone="info">数据不出户</Pill></div>
      </PageHeader>
      <PanelCard title="模型服务">
        <div className={styles.formList}>
          {FIELDS.map((f) => (
            <div key={f.key} className={styles.fieldRow}>
              <label className={styles.fieldLabel}>{f.label}<div className="tiny">{f.key}</div></label>
              <input
                className={"ui-input " + styles.fieldInput}
                placeholder={masked[f.key] ? "已配置：" + masked[f.key] : f.hint}
                value={form[f.key] || ""}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            </div>
          ))}
          <button className={"btn " + styles.saveBtn} onClick={save} disabled={loading}>保存</button>
          {msg ? <div className={styles.saveMsg}>{msg}</div> : null}
        </div>
      </PanelCard>
      {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
      <div className={"tiny " + styles.footLinks}>
        <span>相关视图：</span>
        <Link href="/system/api">服务与接口 →</Link>
        <Link href="/system/health">健康检查 →</Link>
      </div>
    </main>
  );
}
