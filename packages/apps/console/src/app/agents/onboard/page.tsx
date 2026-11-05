"use client";
// agents/onboard 页 · 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数、状态与拼装 (<200 行)。
import { useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { t } from "@/i18n";
import { Alert } from "@/components/primitives";
import { PageTitle } from "@/components/ui/PageHeader";
import StepIndicator from "./_components/StepIndicator";
import StepInfoForm from "./_components/StepInfoForm";
import StepSelectServices from "./_components/StepSelectServices";
import StepConfirm from "./_components/StepConfirm";
import StepResult from "./_components/StepResult";
import type { OnboardForm } from "./_components/types";
import styles from "./page.module.css";

export default function OnboardPage() {
  const { data: services, loading: servicesLoading, error: servicesError } = useApi<any[]>("/api/services-list");
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<OnboardForm>({ agent_id: "", display_name: "", channel: "hermes", host: "" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const toggle = (name: string) => {
    const n = new Set(selected);
    n.has(name) ? n.delete(name) : n.add(name);
    setSelected(n);
  };

  const submit = async () => {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/agent-register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form, channel: form.channel,
          services: Array.from(selected).map(n => ({ name: n })),
          long_term: true, sop_accepted: true,
        }),
      });
      const d = await res.json();
      const data = d?.result?.data?.json || d?.result?.data || d;
      if (d?.error) throw new Error(d.error.message);
      setResult(data); setStep(3);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const copyEnv = () => {
    const lines = [];
    // 2026-10-15 钥匙治理(item 1): register 只发一次性领取券 -> 复制出来的第一行是领取券本身
    //   (装机脚本接受 sk-claim-… 作为 MCP_API_KEY, 会自己换取全部业务钥匙)。
    const ticket = (result as any)?.claim_ticket?.value;
    if (ticket) lines.push(`MCP_API_KEY=${ticket}  # 一次性领取券(默认 15 分钟): 调 /api/v1/agent/claim-service-key 换业务钥匙`);
    for (const [name, s] of Object.entries(result?.services || {})) {
      const sk = (s as any)?.api_key;
      if (sk) lines.push(`${name.toUpperCase()}_API_KEY=${sk}`);
    }
    navigator.clipboard.writeText(lines.join("\n"));
  };

  const restart = () => {
    setStep(0); setResult(null);
    setForm({ agent_id: "", display_name: "", channel: "hermes", host: "" });
    setSelected(new Set());
  };

  return (
    <div className="layout-with-sidebar">
      
      <main className="main">
        <div className="breadcrumb">{t('onboard.crumb')}</div>
        <PageTitle>AI 接入向导</PageTitle>

        {servicesError && <div className={styles.alertRow}><Alert type="error" message="业务服务列表加载失败" description="接入向导第 2 步的勾选项来自 /api/services-list, 当前取数失败, 请刷新重试。" /></div>}

        {/* 步骤指示器 */}
        <StepIndicator step={step} />

        {/* Step 0: 填写信息 */}
        {step === 0 && (
          <StepInfoForm form={form} setForm={setForm} onNext={() => setStep(1)} />
        )}

        {/* Step 1: 选择服务 */}
        {step === 1 && (
          <StepSelectServices
            services={services}
            loading={servicesLoading}
            selected={selected}
            onToggle={toggle}
            onPrev={() => setStep(0)}
            onNext={() => setStep(2)}
          />
        )}

        {/* Step 2: 确认提交 */}
        {step === 2 && (
          <StepConfirm
            form={form}
            selectedList={Array.from(selected).join(", ")}
            error={error}
            loading={loading}
            onPrev={() => setStep(1)}
            onSubmit={submit}
          />
        )}

        {/* Step 3: 获取密钥 */}
        {step === 3 && result && (
          <StepResult result={result} form={form} onCopyEnv={copyEnv} onRestart={restart} />
        )}
        {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
        <div className={"tiny " + styles.relatedLinks}>
          <span>相关视图：</span>
          <Link href="/agents">接入管理 →</Link>
          <Link href="/agents/approvals">审批进度 →</Link>
        </div>
      </main>
    </div>
  );
}
