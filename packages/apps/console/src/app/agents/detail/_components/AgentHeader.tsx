"use client"
// agents/detail 页 · 面包屑 + 页头 + KPI (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { StateChip } from "@/components/DataTable";
import { t as tr } from "@/i18n";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "../page.module.css";

const STATUS_LABEL: Record<string, string> = { ACTIVE: "在线", IDLE: "空闲", OFFLINE: "离线", UNKNOWN: "未知", DISABLED: "已停用" };

export default function AgentHeader({ me, agentId }: { me: any; agentId: string }) {
  return (
    <>
      <div className="breadcrumb"><span className={styles.crumbDim}>{tr('agentDetail.crumb')}</span><span className="sep">/</span><span className="current">{tr('agentDetail.title')}</span></div>
      <PageHeader>
        <PageTitle>
          {me.display_name || agentId}
          <StateChip
            state={String(me.status || "").toUpperCase() === "ACTIVE" ? "ok" : "idle"}
            text={STATUS_LABEL[String(me.status || "").toUpperCase()] || String(me.status || "未知")}
          />
        </PageTitle>
        <div className="page-subtitle">{tr('agentDetail.subtitle')}</div>
      </PageHeader>
      {/* 2026-10-26：删掉这排 KPI 卡 —— 它的 4 个值（id/状态/框架/终端）与下方「基础信息」完全重复，
          同一屏出现两遍是噪声。状态改为标题旁的 chip（色点只表"是否在线"）。 */}
    </>
  );
}
