"use client";
// 2026-10-21 MACS 消息工作区 Phase 1（方案 C：console 内建 /messages）
// 依据：docs/practices/2026-10-21-macs-message-ui-design.md + console 线审视补充
//   （docs/practices/2026-10-21-macs-frontend-review-by-console-line.md）
//
// 2026-10-21 更新：MACS 已切 PG 且后端交接完成 → 库就绪时直接读真数据（/api/macs/*，只读角色），
//   库不可用时回退到示例数据，并在横幅上明确标注**不会假装真数据**（平台纪律：缺失与真值分开）。
// 铁律：console 不直连 chat.db；写操作走 MACS admin BFF（下一阶段）。
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import { useApi } from "@/lib/api";
import MessagesLayout from "./_components/MessagesLayout";
import styles from "./page.module.css";
import LiveBar from "./_components/LiveBar";
// 2026-10-22：本页不再使用示例会话（真实数据优先）；示例数据仅保留在显式 demo 场景。
import { toConversation, type ApiConversation } from "./_data";

export default function MessagesPage() {
  // 2026-10-22：useSearchParams() 在预渲染阶段要求 Suspense 边界，
  //   否则 next build 直接失败（实测 /messages 页 export error）。
  // 2026-11-06 D-03：页头不依赖取数，移到 Suspense 外层。
  //   useSearchParams() 让整个内容区在 SSR 阶段走 fallback(=null)；页头若留在里面，首屏 HTML 就没有 page-header。
  //   面包屑 / 标题 / 说明 / 取数 / 路由参数均未改。
  return (
    <main className="page">
      {/* 2026-11-05 页头口径统一（PAGE-HEADER-31 + 商业线裁决）：PageHero -> 白名单 PageHeader，
          标题按裁决用「消息」；投递诊断的说明保留在下列入口条与各面板里，未删功能。 */}
      <div className="breadcrumb">
        <span className={styles.crumbDim}>服务</span>
        <span className="sep">/</span>
        <span className="current">消息</span>
      </div>
      <PageHeader>
        <PageTitle>消息</PageTitle>
        <div className="page-subtitle">会话消息的投递、失败与治理入口</div>
      </PageHeader>
      <Suspense fallback={null}>
        <MessagesPageInner />
      </Suspense>
    </main>
  );
}

function MessagesPageInner() {
  // 2026-10-21：库就绪与否必须让用户看见（Wave 1.5 前只能是示例数据）。
  // 2026-10-22 深链：/messages?conversation=<id>&message=<id>
  //   通知点进来要能直接定位到具体消息（目标 ④）。只读参数，不改任何后端契约。
  const sp = useSearchParams();
  const initialConversationId = sp.get("conversation") || "";
  const initialMessageId = sp.get("message") || "";
  const { data: status } = useApi<any>("/api/macs-status");
  const ready = status?.ready === true;
  // 2026-10-22 四态：把 loading / error / 重试 透传到列表（空/加载/错误/断线要都看得见）
  const { data: convApi, loading: convLoading, error: convError, mutate: refetchConv } = useApi<any>("/api/macs/conversations");
  const live = ready && Array.isArray(convApi?.conversations) && convApi.conversations.length > 0;
  // 2026-10-22 硬约束「真实数据优先，不混 mock」：加载/失败/空 都不再用示例会话顶替。
  //   加载 → 列表显示骨架；失败 → 错误态 + 重试；空 → 「暂无会话」。示例数据只在显式 demo 页出现。
  const conversations = live
    ? (convApi.conversations as ApiConversation[]).map(toConversation)
    : [];
  return (
    <>
      <LiveBar />
      <div className="msg-quick-links">
        <a href="/messages/failed" className="msg-ghost">未送达消息（失败 / 过期 / 队列）</a>
        <a href="/messages/manage" className="msg-ghost">消息管理（跨会话筛选）</a>
      </div>
      <div className={"msg-mock-banner" + (ready ? " ok" : "")} role="status">
        {convLoading && !convApi
          ? "正在读取消息库…"
          : convError
          ? "消息库读取失败：" + String((convError as any)?.message || convError).slice(0, 60) + "（可点列表里的「重试」）"
          : live
          ? "数据源：消息库（只读）· 真实数据 · " + conversations.length + " 个会话"
          : ready
          ? "消息库已连通，但当前没有会话。"
          : "消息库尚未就绪：本页不展示示例数据，避免与真实消息混淆。"}
      </div>
      <MessagesLayout
        conversations={conversations}
        live={live}
        loading={convLoading}
        error={convError ? String((convError as any)?.message || convError) : null}
        onRetry={refetchConv}
        initialConversationId={initialConversationId}
        initialMessageId={initialMessageId}
      />
    </>
  );
}
