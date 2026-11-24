"use client";
// 0.5.1 B5-14 /flywheel/tasks/new · Bento P6 表单（2026-11-15）
// **本版本只读**（0.5.1 已批准例外）：控件全部禁用，不接写接口、不发起 POST /api/task-create。
// 写通路设计（必填校验 / 二次确认 / 成功后跳详情 / 失败显式错误）登记在本页「提交说明」卡，待 D13–D18 契约开放。
import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import BentoState from "@/components/bento/BentoState";
import { Chips, Note, Tone, usePhaseOverride } from "../../../system/_components/bento-kit";
import kit from "../../../system/_components/bento-kit.module.css";

const TEXT_FIELDS: { key: string; label: string; ph: string; rows: number; required?: boolean }[] = [
  { key: "description", label: "任务描述", ph: "完整描述任务目标与预期成果", rows: 4, required: true },
  { key: "background", label: "背景", ph: "为什么要做这件事", rows: 3 },
  { key: "requirements", label: "要求", ph: "必须满足的要求", rows: 3, required: true },
  { key: "materials", label: "材料", ph: "相关文件 / 链接 / 数据", rows: 2 },
  { key: "acceptanceCriteria", label: "验收标准", ph: "怎样算完成", rows: 3, required: true },
  { key: "qualityStandards", label: "质量标准", ph: "质量底线", rows: 3 },
];

export default function NewTaskPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const forced = usePhaseOverride();
  const phase = forced && forced !== "ok" ? forced : mounted ? "ok" : "loading";

  return (
    <main className="page">
      <h1 className={kit.srOnly}>新建改进任务</h1>
      <PageHeader>
        <PageTitle>新建改进任务</PageTitle>
        <div className="page-subtitle">手工登记改进任务 · 本版本只读（控件禁用，不写入）· 写通路待契约 · 数据时刻 n/a（表单页无数据源）</div>
        <Chips group="飞轮" page="新建任务" readonly={false} />
      </PageHeader>

      {phase === "loading" && <BentoState phase="loading" />}
      {phase === "error" && <BentoState phase="error" title="写通路不可用" detail="端点 POST /api/task-create 未接（本版本只读，不发起请求）；表单字段与校验已就位，待 D13–D18 契约开放。" />}
      {phase === "empty" && <BentoState phase="empty" title="本页无列表数据" detail="表单页没有列表/空集语义；空态 n/a（仅作四态展示）。" />}
      {phase === "unavailable" && <BentoState phase="unavailable" title="写不可用（本版本只读）" detail="POST /api/task-create 写通路未开放；提交按钮禁用，页面仅展示字段与提交说明。" />}

      {phase === "ok" && (
        <BentoGrid>
          <BentoCard span={8} title="任务表单" sub="字段与现有任务契约一致 · 全部控件禁用（只读）">
            <div className={kit.formGrid}>
              <div className={kit.f3}>
                <label className={kit.fieldLabel} htmlFor="title">标题（必填）</label>
                <input id="title" className={kit.input} value="" placeholder="简短的任务标题" disabled />
              </div>
              <div className={kit.f3}>
                <label className={kit.fieldLabel} htmlFor="priority">优先级</label>
                <select id="priority" className={kit.select} defaultValue="P2" disabled>
                  <option value="P1">P1 — 紧急重要</option>
                  <option value="P2">P2 — 计划执行</option>
                  <option value="P3">P3 — 有空再做</option>
                </select>
              </div>
              <div className={kit.f3}>
                <label className={kit.fieldLabel} htmlFor="effort">预估工时</label>
                <input id="effort" className={kit.input} value="" placeholder="如 30分钟 / 2小时" disabled />
              </div>
              {TEXT_FIELDS.map((f) => (
                <div key={f.key} className={kit.f12}>
                  <label className={kit.fieldLabel} htmlFor={f.key}>{f.label}{f.required ? "（必填）" : ""}</label>
                  <textarea id={f.key} className={kit.textarea} rows={f.rows} value="" placeholder={f.ph} disabled />
                </div>
              ))}
            </div>
            <Note>字段说明：标题/任务描述/要求/验收标准为必填；背景/材料/质量标准可选。全部为禁用态（本版本只读）。</Note>
          </BentoCard>

          <BentoCard span={4} title="提交说明" sub="本版本只读（已批准例外）">
            <div style={{ marginBottom: 8 }}><Tone tone="warn">本版本只读</Tone></div>
            <ul className={kit.kv}>
              <li><span>写操作</span><b>POST /api/task-create 未开放；提交按钮禁用，不发起请求、不代跑。</b></li>
              <li><span>必填校验</span><b>标题、任务描述、要求、验收标准为必填；空值不允许提交（本版本不触发）。</b></li>
              <li><span>二次确认</span><b>提交前需 confirm 确认（写通路设计，本版本不渲染确认框）。</b></li>
              <li><span>成功后</span><b>跳转 /flywheel/tasks/&lt;id&gt; 详情（写通路设计）。</b></li>
              <li><span>失败</span><b>显式错误（中文 + 端点 + HTTP 状态码 + 重试），不吞错（写通路设计）。</b></li>
              <li><span>审计 / 幂等</span><b>写路径需服务端审计与幂等键；契约未定，本批不接。</b></li>
            </ul>
          </BentoCard>

          <BentoCard span={12} title="操作区">
            <div className={kit.actions}>
              <button type="button" className={kit.btnPrimary} disabled title="本版本只读：写通路未开放">创建任务（禁用）</button>
              <Link href="/flywheel/tasks" className={kit.btnGhost} style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>取消并返回任务列表</Link>
              <span className={kit.muted}>本版本只读：控件禁用 + 「本版本只读」说明；写通路待 D13–D18 契约（不新增 BFF）。</span>
            </div>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}