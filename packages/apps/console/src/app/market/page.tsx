"use client";
// 「服务商城」——列出已收录的三方服务（F2）。数据源：services/index.json（console 代理 /api/market/services）。
import { useEffect, useState } from "react";
import { PageHero, Pill, PanelCard } from "@/components/ui";

interface Svc { id: string; name: string | null; version: string | null; vendor: string | null; pricing: string | null; capabilities: number; permissions: string[]; valid: boolean; status?: string }
const PRICE_LABEL: Record<string, string> = { free: "免费", "one-time": "一次性", subscription: "订阅", metered: "按量" };
const STATUS_LABEL: Record<string, string> = { pending: "待审核", approved: "已通过", rejected: "已驳回" };

export default function MarketPage() {
  const [list, setList] = useState<Svc[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    fetch("/api/market/services").then((r) => r.json()).then((j: { services?: Svc[]; error?: string }) => {
      setList(j.services || []);
      if (j.error) setMsg(j.error);
    }).catch(() => setMsg("读取失败"));
  }, []);
  return (
    <main className="page">
      <PageHero title="服务商城" subtitle="已收录的三方服务；审核通过后上架" tags={<Pill tone="info">审核制</Pill>} />
      {msg ? <div className="tiny">{msg}</div> : null}
      <PanelCard title={"服务（" + list.length + "）"}>
        {list.length === 0 ? <div className="tiny">暂无已收录服务</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
            {list.map((s) => (
              <div key={s.id} style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--sp-2)" }}>
                <div style={{ fontSize: "var(--fs-lg)" }}>{s.name || s.id} <span className="tiny">v{s.version || "?"} · {s.vendor || "?"}</span></div>
                <div className="tiny">定价：{PRICE_LABEL[String(s.pricing)] || s.pricing || "?"} · 能力 {s.capabilities} 项 · 权限：{(s.permissions || []).join(" / ") || "无"}</div>
                <div className="tiny">审核：{STATUS_LABEL[String(s.status)] || s.status || "待审核"} · {s.valid ? "契约校验通过" : "契约校验未通过"}</div>
              </div>
            ))}
          </div>
        )}
      </PanelCard>
      <div className="tiny" style={{ marginTop: "var(--sp-4)" }}>只读目录 · 安装/结算将在后续版本开放</div>
    </main>
  );
}
