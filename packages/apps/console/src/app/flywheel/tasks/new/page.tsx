"use client";
// 2026-10-13 round 76-BT: 从 selfimproving 的 /tasks/new 搬来 —— console 一直独缺"手工建任务"。
//   数据与副作用走 console 的 BFF /api/task-create(-> selfimproving 的 tRPC task.create)。
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Button, Input } from "@/components/primitives";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";

const TEXT_FIELDS: { key: string; label: string; ph: string; rows: number }[] = [
  { key: "description", label: "任务描述", ph: "完整描述任务目标与预期成果", rows: 4 },
  { key: "background", label: "背景", ph: "为什么要做这件事", rows: 3 },
  { key: "requirements", label: "要求", ph: "必须满足的要求", rows: 3 },
  { key: "materials", label: "材料", ph: "相关文件 / 链接 / 数据", rows: 2 },
  { key: "acceptanceCriteria", label: "验收标准", ph: "怎样算完成", rows: 3 },
  { key: "qualityStandards", label: "质量标准", ph: "质量底线", rows: 3 },
];

export default function NewTaskPage() {
  const router = useRouter();
  const [form, setForm] = useState<Record<string, string>>({
    title: "", priority: "P2", estimatedEffort: "", description: "", background: "",
    requirements: "", materials: "", acceptanceCriteria: "", qualityStandards: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/task-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(String(j?.error || ("请求失败（状态码 " + r.status + "）")));
      router.push("/flywheel/tasks/" + j.task.id);
    } catch (e2) {
      setErr(String((e2 as Error)?.message || e2));
    } finally { setBusy(false); }
  }

  const label = (t: string) => <span style={{ display: "block", fontSize: "var(--fs-base)", color: "var(--text-dim)", marginBottom: "var(--sp-1-5)" }}>{t}</span>;
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>飞轮引擎</span><span className="sep">/</span><Link href="/flywheel/tasks" style={{ color: "inherit" }}>改进任务看板</Link><span className="sep">/</span><span className="current">新建</span></div>
    <PageHeader><PageTitle>新建改进任务</PageTitle><div className="page-subtitle">手工登记一个改进任务；提交后会写飞轮事件、审计，并同步通知 Mind。</div></PageHeader>
    {err && <div style={{ marginBottom: "var(--sp-3)" }}><Alert type="error" message="创建失败" description={err.slice(0, 200)} /></div>}
    <form onSubmit={submit} className="panel" style={{ padding: "var(--sp-4)", maxWidth: 900 }}>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "var(--sp-3)", marginBottom: "var(--sp-3-5)" }}>
        <div>{label("标题（必填）")}<Input value={form.title} onChange={set("title")} placeholder="简短的任务标题" /></div>
        <div>{label("优先级")}
          <select className="ui-input" value={form.priority} onChange={set("priority")} style={{ width: "100%", height: 30 }}>
            <option value="P1">P1 — 紧急重要</option>
            <option value="P2">P2 — 计划执行</option>
            <option value="P3">P3 — 有空再做</option>
          </select></div>
        <div>{label("预估工时")}<Input value={form.estimatedEffort} onChange={set("estimatedEffort")} placeholder="如 30分钟 / 2小时" /></div>
      </div>
      {TEXT_FIELDS.map((f) => (
        <div key={f.key} style={{ marginBottom: "var(--sp-3-5)" }}>
          {label(f.label + "（必填）")}
          <textarea className="ui-input ui-textarea" rows={f.rows} value={form[f.key]} onChange={set(f.key)} placeholder={f.ph} style={{ width: "100%" }} />
        </div>
      ))}
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <Button type="primary" htmlType="submit" disabled={busy}>{busy ? "创建中…" : "创建任务"}</Button>
        <Link href="/flywheel/tasks"><Button type="default" disabled={busy}>取消</Button></Link>
      </div>
    </form>
  </main></div>);
}
