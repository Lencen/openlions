"use client";
// 2026-09-14 UI-3 (todo_a76adfd6303d4e6d9f16): 认知五表 (记忆/知识/反思/实践/技能) 统一的详情侧边抽屉。
// 用户反馈: "点详情会跳到另一个页面, 回来筛选条件全丢" -> 改为在列表页就地用 Drawer 打开详情:
//   - 列表组件不卸载, 搜索词 / 排序 / 页码 / 滚动位置全部保持;
//   - 仍保留完整详情页深链接 (抽屉内 "在新标签打开完整详情页"), 详情页路由不删;
//   - 抽屉开合状态写回 URL (?open=<id>), 可分享可刷新。
import type { ReactNode } from "react";
import { Drawer } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import MemoryDetailBody from "./MemoryDetailBody";
import KnowledgeDetailBody from "./KnowledgeDetailBody";
import PracticeDetailBody from "./PracticeDetailBody";
import SkillDetailBody from "./SkillDetailBody";
import ReflectionDetailBody from "./ReflectionDetailBody";

export type CognitiveKind = "memory" | "knowledge" | "practice" | "skill" | "reflection";

const META: Record<CognitiveKind, { label: string; href: (id: string) => string }> = {
  memory: { label: "记忆", href: (id) => "/cognitive/memory/detail?id=" + encodeURIComponent(id) },
  knowledge: { label: "知识", href: (id) => "/cognitive/knowledge/detail?id=" + encodeURIComponent(id) },
  practice: { label: "实践", href: (id) => "/cognitive/practice/detail?id=" + encodeURIComponent(id) },
  skill: { label: "技能", href: (id) => "/cognitive/skills/detail?id=" + encodeURIComponent(id) },
  reflection: { label: "反思", href: (id) => "/cognitive/reflection/detail?id=" + encodeURIComponent(id) },
};

function DrawerHead({ title, id }: { title: string; id: string }) {
  return (
    <div style={{ marginBottom: "var(--sp-3)", paddingBottom: "var(--sp-2)", borderBottom: "1px solid var(--border)" }}>
      <div style={{ fontSize: "var(--fs-lg)", fontWeight: 600, lineHeight: 1.5 }}>{title}</div>
      <div className="tiny mono" style={{ wordBreak: "break-all" }}>{id}</div>
    </div>
  );
}

export default function CognitiveDetailDrawer({
  kind,
  id,
  open,
  onClose,
}: {
  kind: CognitiveKind;
  id: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const meta = META[kind];

  let body: ReactNode = null;
  if (id) {
    if (kind === "memory") {
      body = <MemoryDetailBody id={id} renderHeader={(m: any) => <DrawerHead title={m.title || "记忆详情"} id={m.id || id} />} />;
    } else if (kind === "knowledge") {
      body = <KnowledgeDetailBody id={id} renderHeader={(k: any) => <DrawerHead title={k.title || "知识详情"} id={k.id || id} />} />;
    } else if (kind === "practice") {
      body = <PracticeDetailBody id={id} renderHeader={(p: any) => <DrawerHead title={p.title || "实践详情"} id={p.id || id} />} />;
    } else if (kind === "skill") {
      body = <SkillDetailBody id={id} renderHeader={(s: any) => <DrawerHead title={s.name || "技能详情"} id={s.id || id} />} />;
    } else {
      body = (
        <ReflectionDetailBody
          id={id}
          renderHeader={(ctx: any) => (
            <DrawerHead title={ctx.fw ? `主题反思 · ${ctx.fw.theme}` : ctx.legacy?.title || "反思详情"} id={ctx.discEntityId || id} />
          )}
        />
      );
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size={860}
      title={
        <span>
          {meta.label}详情 · 侧边预览
          <span className="tiny" style={{ marginLeft: "var(--sp-2)", fontWeight: 400 }}>列表未离开，筛选条件与位置保持</span>
        </span>
      }
      styles={{ body: { padding: "var(--sp-4)" } }}
      destroyOnHidden
    >
      {!id ? null : (
        <div>
          <div style={{ display: "flex", gap: "var(--sp-2-5)", alignItems: "center", flexWrap: "wrap", marginBottom: "var(--sp-2-5)" }}>
            <a href={meta.href(id)} target="_blank" rel="noreferrer" style={{ fontSize: "var(--fs-base)", color: "var(--primary)" }}>
              ↗ 在新标签打开完整详情页（深链接）
            </a>
            <span className="tiny" style={{ color: "var(--text-dim)" }}>关闭抽屉（Esc / 点遮罩 / ✕）后仍在原列表位置与筛选条件下</span>
          </div>
          {body}
        </div>
      )}
    </Drawer>
  );
}
