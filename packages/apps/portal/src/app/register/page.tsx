"use client";
import { useEffect, useState } from "react";

export default function RegisterPage() {
  const [form, setForm] = useState({ agent_id: "", display_name: "", channel: "custom", host: "", framework: "openclaw" });
  // 2026-09-07: agent 声明想接入的业务 (审批时默认预勾选, 管理员可增删)
  const [wanted, setWanted] = useState<Record<string, boolean>>({});
  // 开源版只 seed 了两条服务；MCP 跨 Agent 通信不在开源范围。
  const SERVICE_OPTIONS = [
    { name: "lions_mind", label: "Mind 认知中枢" },
    { name: "lions_session", label: "会话归档 Session" },
  ];
  const [result, setResult] = useState<any>(null);
  // 2026-10-30：注册后（含 PENDING）直接给下载入口 —— "先装客户端，再换券"，避免用户卡在"下一步做什么"
  const [latest, setLatest] = useState<any>(null);
  useEffect(() => {
    fetch("/api/client-latest")
      .then((r) => r.json())
      .then((d) => { if (d?.ok) setLatest(d); })
      .catch(() => {});
  }, []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setLoading(true); setError("");
    try {
      const r = await fetch("/api/portal/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: form.agent_id,
          display_name: form.display_name,
          channel: form.channel,
          host: form.host,
          profile: { framework: form.framework },
          services: Object.entries(wanted).filter(([, v]) => v).map(([name]) => name),
        }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "注册失败");
      setResult(d);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const DownloadCard = () => (
    <div className="panel" style={{ padding: 16, marginTop: 16, textAlign: "left" }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>① 先装客户端（每个 agent 都要装）</div>
      {latest ? (
        <>
          <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.9 }}>
            最新版本 <b>{latest.version}</b>（{latest.platform}/{latest.arch}，{latest.size} 字节，
            {latest.signed ? "已签名" : "未签名"}）
            <br />
            sha256 <code style={{ fontSize: 11 }}>{latest.sha256}</code>
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <a href="/api/client-download" className="btn btn-primary" style={{ textDecoration: "none", padding: "7px 14px", borderRadius: 8 }}>
              下载安装包
            </a>
            <a href="/client" style={{ color: "var(--primary)", fontSize: 12 }}>下载页 / 校验说明</a>
            <a href="/guide" style={{ color: "var(--primary)", fontSize: 12 }}>安装手册</a>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.8 }}>
            装完执行 <code>LIONS_CLIENT_INSTANCE=&lt;实例&gt; lions-client doctor</code>，退出码 0 才算装好。
            机器可读元数据：<code>/api/client-latest</code>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          暂无已发布安装包（发布后会在这里出现，同 <a href="/client" style={{ color: "var(--primary)" }}>下载页</a>）。
        </div>
      )}
    </div>
  );

  const input = { width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-surface)", color: "var(--text)", fontSize: 13, outline: "none" } as const;

  if (result?.pending) {
    return (
      <main className="main" style={{ marginLeft: 0, padding: "48px 32px", maxWidth: 560, margin: "0 auto" }}>
        <div className="panel" style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>🛂</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>注册已提交, 等待管理员审批</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13, lineHeight: 1.8, marginBottom: 16 }}>
            Agent <code>{result.agent?.agent_id}</code> 已进入 PENDING 状态。<br />
            管理员审批通过后会给你 <b>一张一次性领取券</b>（领取后 15 分钟内有效、只能用一次）。
            用它在装机时换取正式钥匙（有效期 90 天），换过一次这张券就作废。
          </p>
          <p style={{ fontSize: 12, textAlign: "left", background: "var(--bg-surface2)", borderRadius: 8, padding: 12, lineHeight: 1.8, fontFamily: "var(--font-mono)" }}>
            {"POST /api/v1/agent/claim-service-key"}
            <br />
            {"Header: Content-Type: application/json"}
            <br />
            {"body: " + '{ "agent_id": "' + (result.agent?.agent_id || "") + '", "ticket": "<管理员给你的领取券>" }'}
          </p>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 10, lineHeight: 1.8 }}>
            已经有一把正式钥匙的机器, 也可以带 <code>X-API-Key</code> 调 <code>POST /api/portal/heartbeat</code>
            取回发放 1 小时内的钥匙原文; 匿名调用只返回审批状态, 不返回钥匙原文。
          </p>
          {result.approveUrl && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
              管理员审批入口：<a href={result.approveUrl} style={{ color: "var(--primary)" }}>Console → 智能体 → 接入审批</a>
            </p>
          )}
          <DownloadCard />
          <div style={{ marginTop: 16, fontSize: 12, color: "var(--text-muted)" }}>
            也可以先看 <a href="/guide" style={{ color: "var(--primary)" }}>接入手册</a> 了解平台能力
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="main" style={{ marginLeft: 0, padding: "32px", maxWidth: 560, margin: "0 auto" }}>
      <div className="breadcrumb">
        <span style={{ color: "var(--text-dim)" }}>AI 接入层</span>
        <span className="sep">/</span>
        <span className="current">Agent 自助注册</span>
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Agent 自助注册</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }}>
        提交后进入 PENDING, 管理员审批通过后会给你一张一次性领取券, 用它换取正式钥匙后即可访问平台能力。
        客户端可以先装（装完再填注册也一样，见下方 ①）。
      </p>

      <DownloadCard />

      <div className="panel">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--text-dim)", display: "block", marginBottom: 5 }}>Agent ID (kebab-case) <span style={{ color: "var(--primary)" }}>*</span></label>
            <input style={input} value={form.agent_id} placeholder="agent-my-robot" onChange={(e) => setForm({ ...form, agent_id: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--text-dim)", display: "block", marginBottom: 5 }}>显示名称 <span style={{ color: "var(--primary)" }}>*</span></label>
            <input style={input} value={form.display_name} placeholder="我的机器人" onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, color: "var(--text-dim)", display: "block", marginBottom: 5 }}>Agent 平台</label>
              <select style={input} value={form.framework} onChange={(e) => setForm({ ...form, framework: e.target.value, channel: e.target.value === "hermes" ? "hermes" : "custom" })}>
                <option value="openclaw">OpenClaw</option>
                <option value="hermes">Hermes</option>
                <option value="dsh">DSH (agent-x Harness)</option>
                <option value="custom">其他</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, color: "var(--text-dim)", display: "block", marginBottom: 5 }}>运行主机 (host) <span style={{ color: "var(--primary)" }}>*</span></label>
              <input style={input} value={form.host} placeholder="agent-host" onChange={(e) => setForm({ ...form, host: e.target.value })} />
            </div>
          </div>

          <div>
            <label style={{ fontSize: 12, color: "var(--text-dim)", display: "block", marginBottom: 5 }}>
              想接入的业务 <span style={{ color: "var(--text-dim)" }}>(可多选，审批时管理员会确认)</span>
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", padding: "8px 0" }}>
              {SERVICE_OPTIONS.map((s) => (
                <label key={s.name} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={!!wanted[s.name]}
                    onChange={() => setWanted((prev) => ({ ...prev, [s.name]: !prev[s.name] }))}
                  />
                  {s.label}
                </label>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              不选 = 审批通过后只发身份不授权业务 (管理员可随时在控制台补授权)
            </div>
          </div>

          {error && <div style={{ color: "var(--status-crit)", fontSize: 12 }}>⚠ {error}</div>}
            {/* 2026-10-19 修复: 原来只有一颗 disabled 的按钮、且不说为什么; 这里把"还差什么"明说。 */}
            {(() => {
              const miss: string[] = [];
              if (!form.agent_id) miss.push("Agent ID");
              if (!form.display_name) miss.push("显示名称");
              if (!form.host) miss.push("运行主机");
              return miss.length > 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  还需填写 <span style={{ color: "var(--primary)" }}>{miss.join("、")}</span>，填完即可提交
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>信息已齐全，可以提交</div>
              );
            })()}

          <button
            onClick={submit}
            disabled={loading || !form.agent_id || !form.display_name || !form.host}
            style={{ padding: "10px 16px", borderRadius: 8, background: "var(--primary)", color: "var(--on-primary)", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600, opacity: loading || !form.agent_id || !form.display_name || !form.host ? 0.5 : 1 }}
          >
            {loading ? "提交中..." : "提交注册申请"}
          </button>
          <div style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center" }}>
            已有密钥? 直接看 <a href="/guide" style={{ color: "var(--primary)" }}>接入手册</a> 开始使用
          </div>
        </div>
      </div>
    </main>
  );
}
