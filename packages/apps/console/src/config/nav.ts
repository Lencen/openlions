// 2026-09-21 IA 重构(前置-1, 用户确认版): 8 个顶级模块, 参考 agent-x Demo/规范但适配本平台。
//   顶级只放模块, 详情一律从列表进; 详情级菜单项(/agents/detail、/agents/config 等)清零;
//   看板不占菜单(模块默认页=看板, 列表/子页走 Tab+嵌套路由, 均可深链)。
// 结构: 工作台 | 待办中心 | 会话与协同 | 智能体(含接入管理二级) | 认知资产 | 飞轮(聚合) | 业务系统(预留) | 平台管理
// 历史说明: 2026-09-10 商业化改版(5 组平铺)已废弃; 页面路由全部保留, 仅菜单归位。
import { t } from '@/i18n';

export interface NavItem {
  /** 文案 key (唯一标识, 用于 i18n 取词) */
  id: string;
  /** 顶层项可无 href(纯分组标题, 如二级菜单父项); 子项必须带 href */
  href?: string;
  label: string;
  icon: string;
  desc?: string;
  badge?: 'new';
  /** 2026-11-06: 在全局搜索里标为"工具页"(nav 入口仍在), 见 searchIndex 的 utility 字段 */
  utility?: boolean;
  /** 2026-09-21: 二级菜单(接入管理 / 飞轮聚合 / 系统子页), antd 语义 children=submenu */
  children?: NavItem[];
  /** 2026-09-21: 预留项(如业务系统), 渲染为禁用 */
  locked?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  color: string;
  items: NavItem[];
}

/** 分组定义 (文案 key 集中登记在 zh-CN.ts) */
const GROUP_DEFS: { id: string; labelKey: string; color: string }[] = [
  { id: 'workbench', labelKey: 'nav.group.workbench', color: 'var(--text-dim)' },
  { id: 'comm', labelKey: 'nav.group.comm', color: 'var(--text-dim)' },
  { id: 'agent', labelKey: 'nav.group.agent', color: 'var(--text-dim)' },
  { id: 'cognition', labelKey: 'nav.group.cognition', color: 'var(--text-dim)' },
  { id: 'flywheel', labelKey: 'nav.group.flywheel', color: 'var(--text-dim)' },
  { id: 'business', labelKey: 'nav.group.business', color: 'var(--text-dim)' },
  { id: 'platform', labelKey: 'nav.group.platform', color: 'var(--text-dim)' },
];

/** 条目定义: [group, id, href?, icon, children?, locked?] — 文案 key = nav.item.<id>.label/desc */
const ITEM_DEFS: { group: string; id: string; href?: string; icon: string; badge?: 'new'; utility?: boolean; children?: { id: string; href: string; icon: string }[]; locked?: boolean }[] = [
  // ── 工作台 ──
  // ord-078: /workbench 下线（301 → /），入口移除，见 docs/design/uiux-bento-2026-11/OFFLINE-SCOPE-078.md
  { group: 'workbench', id: 'home', href: '/', icon: 'dashboard' },
  { group: 'workbench', id: 'daily', href: '/audit/daily-summary', icon: 'calendar' },
  // ── 待办中心 (独立顶级, 人类决策入口) ──
  // 2026-09-24: 曾加过一个独立的「待我处理」菜单项(/approvals), 已撤销 ——
  //   它只是 /todo 的 ownerType=human 过滤视图, 而 /todo **本就有**「负责人」筛选 +
  //   「需要人决策」指标 + 治理「通过并执行」动作。按 2026-09-21 IA 整改
  //   「看板不占菜单; 列表/子页走 Tab+嵌套路由」, 同一实体的过滤视图不另占菜单位,
  //   改为 /todo?owner=human 深链(顶栏徽标用)。
  // 2026-10-25 R3: 「待办中心」并入工作台 —— 顶层分组收口到 7 个（评审 §3 第 5 条）。
  { group: 'workbench', id: 'todo', href: '/todo', icon: 'check-square' },
  // ── 会话与协同 (会话记录 + MACS) ──
  { group: 'comm', id: 'sessions', href: '/sessions', icon: 'message-square', badge: 'new' },
  // ord-078: /system/comm 下线（301 → /messages），入口移除；MACS 工作区改用 /messages

  // 2026-10-21 Phase 1：MACS 消息工作区（console 内建，方案 C）
  { group: 'comm', id: 'messages', href: '/messages', icon: 'mail', badge: 'new' },
  // 2026-10-21 Phase 3：跨会话消息管理表格（只读）
  { group: 'comm', id: 'messagesManage', href: '/messages/manage', icon: 'folder' },
  // 2026-10-22 Session Principal：同一智能体的并行会话（三查询骨架）
  { group: 'comm', id: 'messagesSession', href: '/messages/session', icon: 'git-branch' },
  // ── 智能体 (含接入管理二级) ──
  { group: 'agent', id: 'agents', href: '/agents', icon: 'bot' },
  { group: 'agent', id: 'agentsLive', href: '/agents-live', icon: 'activity' },
  { group: 'agent', id: 'access', icon: 'plug', children: [
    { id: 'approvals', href: '/agents/approvals', icon: 'shield-check' },
    // ia-ok: 钥匙审批与「接入审批」是两个不同对象（key 生命周期 vs 服务授权），
    //   合并会让审批人分不清"批的是哪张表"，故作为接入管理下的并列子页；不是列表过滤视图。
    { id: 'agentKeys', href: '/agents/keys', icon: 'key' },
    { id: 'capabilities', href: '/agents/capabilities', icon: 'wrench' },
    { id: 'onboard', href: '/agents/onboard', icon: 'rocket' },
    { id: 'transfer', href: '/agents/transfer', icon: 'refresh' },
  ] },
  // 组织架构 (2026-09-21 Q6#1: 角色/岗位/agent + 汇报关系 + 小组)
  { group: 'agent', id: 'org', href: '/agents/org', icon: 'building', badge: 'new' },
  // ── 认知资产 ──
  { group: 'cognition', id: 'cognitive', href: '/cognitive', icon: 'cpu' },
  { group: 'cognition', id: 'memory', href: '/cognitive/memory', icon: 'package' },
  { group: 'cognition', id: 'knowledge', href: '/cognitive/knowledge', icon: 'book' },
  // 2026-09-24 IA 整改 (todo_c73421c8e82c424e97e7): 原「知识治理」菜单项
  // { id:'governance', href:'/cognitive/knowledge/governance' } 已撤掉 ——
  //   它是 /cognitive/knowledge 的子页(面包屑 认知资产/知识库/知识治理), 违反
  //   2026-09-21 IA 重构「看板不占菜单; 列表/子页走 Tab+嵌套路由, 均可深链」。
  //   治理概览现为知识库页内 Tab, 深链 /cognitive/knowledge?tab=governance;
  //   旧路由 /cognitive/knowledge/governance 保留为重定向(不 404)。
  { group: 'cognition', id: 'reflection', href: '/cognitive/reflection', icon: 'message-dots' },
  { group: 'cognition', id: 'practice', href: '/cognitive/practice', icon: 'wrench' },
  { group: 'cognition', id: 'skills', href: '/cognitive/skills', icon: 'target' },
  { group: 'cognition', id: 'lineage', href: '/lineage', icon: 'git-branch' },
  // ── 飞轮 (独立顶级, 9 子页聚合为 5 项) ──
  { group: 'flywheel', id: 'flywheel', href: '/flywheel', icon: 'refresh' },
  // ord-078: /flywheel/business 下线（301 → /market），入口移除；业务维度看板并入 /market 六域
  //   原 ia-ok 理由见 OFFLINE-SCOPE-078.md §2（候选 3）。
  // ia-ok: 「它在学」是**面向用户**的模块级入口, 与 /flywheel(面向运维的飞轮看板)受众与目的都不同 ——
  //        它只回答一个问题:「它最近学到了什么」。按守门 R6 的要求在此写明理由; 不是过滤视图, 故不走 Tab。
  //        依据: docs/practices/2026-10-15-console-data-display-guidelines.md §5 第 ④ 项。
  { group: 'flywheel', id: 'learning', href: '/flywheel/learning', icon: 'sprout', badge: 'new' },
  { group: 'flywheel', id: 'hardMetrics', href: '/flywheel/hard-metrics', icon: 'bar-chart', badge: 'new' },
  { group: 'flywheel', id: 'llmUsage', href: '/flywheel/llm-usage', icon: 'banknote', badge: 'new' },
  { group: 'flywheel', id: 'tasks', href: '/flywheel/tasks', icon: 'check-square' },
  { group: 'flywheel', id: 'flowGroup', icon: 'settings', children: [
    { id: 'flow', href: '/flywheel/flow', icon: 'settings' },
    { id: 'executions', href: '/flywheel/executions', icon: 'activity' },
  ] },
  { group: 'flywheel', id: 'reflectGroup', icon: 'lightbulb', children: [
    { id: 'reflections', href: '/flywheel/reflections', icon: 'lightbulb' },
    { id: 'findings', href: '/flywheel/findings', icon: 'search' },
    { id: 'coverage', href: '/flywheel/coverage', icon: 'trending-up' },
  ] },
  { group: 'flywheel', id: 'auditGroup', icon: 'clipboard', children: [
    { id: 'audit', href: '/flywheel/audit', icon: 'clipboard' },
    { id: 'logs', href: '/flywheel/logs', icon: 'file-text' },
  ] },
  // ── 业务系统 (预留空态; 计划接入: 开发流水线/NAS/儿童学习/Agent体系学习/荐股) ──
  { group: 'business', id: 'businessPlanned', icon: 'building', locked: true },
  // ia-ok: 服务商城是**模块级入口**（三方服务目录/上架），不是过滤视图/子页。
  { group: 'business', id: 'market', href: '/market', icon: 'store' },
  // ── 平台管理 ──
  { group: 'platform', id: 'system', href: '/system', icon: 'puzzle', children: [
    { id: 'business', href: '/system/business', icon: 'clipboard' },
    { id: 'auth', href: '/system/auth', icon: 'lock' },
    { id: 'permissions', href: '/system/permissions', icon: 'shield' },
    { id: 'pipeline', href: '/system/pipeline', icon: 'git-branch' },
    { id: 'health', href: '/system/health', icon: 'heart' },
    { id: 'accessLog', href: '/system/access-log', icon: 'file-text' },
    { id: 'automation', href: '/system/automation', icon: 'settings' },
    // 2026-10-13 round 76-BM: mind 的 /rotation 搬进 console 后的入口
    // ia-ok: /system/rotation 是"平台管理"模块下与 automation/guards 并列的**模块级入口**(飞轮自动轮转的启停与定时配置),
    //   非某列表的过滤视图, 也没有父列表可挂 Tab —— 故作为独立菜单项。
    { id: 'rotation', href: '/system/rotation', icon: 'rotate' },
    // 2026-09-24 守门机制总表 (todo_15c3785dd8b34c5a85d0): 平台全部守门机制的单一入口
    // ia-ok: /system/guards 是"平台管理"模块下与 access-log/health/automation 并列的只读模块入口(非某列表的过滤视图, 也非详情页); 数据源为 docs/platform-logic/guard-registry.json, 无父列表可挂 Tab。
    { id: 'guards', href: '/system/guards', icon: 'cone' },
    // 2026-10-26 资产可见性设置（asset-line 契约 §19 / 冻结清单 docs/notes/2026-10-26-asset-visibility-copy-frozen.md）
    // ia-ok: /system/assets 是"平台管理"下的**模块级入口**（记忆/知识/技能三类的可见性策略展示与切换），
    //   不是某个列表的过滤视图，也没有父列表可挂 Tab；与 permissions（谁能访问）职责不同，故独立成项。
    { id: 'assetVisibility', href: '/system/assets', icon: 'shield' },
    //   不是某列表的过滤视图，也没有父列表可挂 Tab；与 guards（机制目录）职责不同，故独立成项。
    // 2026-10-29 客户端版本管理（老板要求：发布即签名、portal 只给最新）
    // ia-ok: /system/client-releases 是"平台管理"下的**模块级入口**（客户端发布记录、签名状态与通道），
    //   不是某个列表的过滤视图，也没有父列表可挂 Tab；与 commercial（商业化门禁）职责不同，故独立成项。
    { id: 'clientReleases', href: '/system/client-releases', icon: 'plug' },
  ] },
  { group: 'platform', id: 'systemApi', href: '/system/api', icon: 'plug' },
  { group: 'platform', id: 'cost', href: '/cost', icon: 'coins' },
  { group: 'platform', id: 'auditOps', href: '/audit', icon: 'eye' },
  // 2026-11-06 版本看板（商业化线任务）：0.4.30–0.4.33 四车 × REQ/BUG/SEC/TASK，内容由商业化线维护，页面只读。
  // ia-ok: 模块级只读入口（一次看四车排期），不是列表过滤视图，也没有父列表可挂 Tab。
  // utility=true：全局搜索里标为"工具页"（常规从菜单进，搜索也能找到）。
  { group: 'platform', id: 'versionBoard', href: '/system/version-board', icon: 'package', utility: true },
  // 2026-11-06 可观测性（0.4.32-03/05）：验收 FAIL 按 owner/类型/严重度分组，只读。
  // ia-ok: /system/observability 是"平台管理"下的**模块级只读入口**（一次看三组分布），
  //   不是某列表的过滤视图，也没有父列表可挂 Tab；与 versionBoard（版本看板）职责不同。
  { group: 'platform', id: 'observability', href: '/system/observability', icon: 'activity' },
  { group: 'platform', id: 'platformLogic', href: '/platform/logic', icon: 'compass' },
  // ia-ok: /design 是“平台管理”下的模块级入口（设计规范总览/视觉基线页），不是任何列表的过滤视图。
  { group: 'platform', id: 'design', href: '/design', icon: 'puzzle' },
  // ia-ok: 模型配置是**模块级入口**（用户自带 key 的配置面，路线图 §1.2），不是过滤视图/子页，故不进 Tab。
  { group: 'platform', id: 'modelConfig', href: '/platform/model', icon: 'key' },
  // ia-ok: 运营看板是**模块级入口**（产能与成本的一屏总览），不是过滤视图/子页，故不进 Tab。
  { group: 'platform', id: 'opsBoard', href: '/platform/ops', icon: 'trending-up' },
];

/** 把 ITEM_DEFS 展开为带文案的 NavItem 树 */
function hydrate(def: { id: string; href?: string; icon: string; badge?: 'new'; utility?: boolean; children?: { id: string; href: string; icon: string }[]; locked?: boolean }): NavItem {
  const label = t(`nav.item.${def.id}.label`);
  const desc = t(`nav.item.${def.id}.desc`);
  return {
    id: def.id,
    href: def.href,
    label,
    icon: def.icon,
    badge: def.badge,
    locked: def.locked,
    utility: def.utility,
    desc: desc && !desc.startsWith('nav.item') ? desc : undefined,
    children: def.children ? def.children.map((c) => ({
      id: c.id, href: c.href, icon: c.icon,
      label: t(`nav.item.${c.id}.label`),
      desc: (() => { const d = t(`nav.item.${c.id}.desc`); return d && !d.startsWith('nav.item') ? d : undefined; })(),
    })) : undefined,
  };
}

export const NAV_GROUPS: NavGroup[] = GROUP_DEFS.map((g) => ({
  id: g.id,
  label: t(g.labelKey),
  color: g.color,
  items: ITEM_DEFS.filter((it) => it.group === g.id).map(hydrate),
}));

/** 根据当前 pathname 找命中的导航项与分组 (含二级 children) */
export function matchNav(pathname: string): { group: NavGroup; item: NavItem; parent?: NavItem } | null {
  const path = pathname || '/';
  let best: { group: NavGroup; item: NavItem; parent?: NavItem } | null = null;
  for (const g of NAV_GROUPS) {
    for (const it of g.items) {
      if (it.href === path) return { group: g, item: it };
      if (it.href && it.href !== '/' && path.startsWith(it.href)) {
        if (!best || it.href.length > best.item.href.length) best = { group: g, item: it };
      }
      for (const c of it.children || []) {
        if (c.href === path) return { group: g, item: c, parent: it };
        if (path.startsWith(c.href) && c.href !== '/') {
          if (!best || c.href.length > best.item.href.length) best = { group: g, item: c, parent: it };
        }
      }
    }
  }
  return best;
}

/** 侧边栏默认展开分组与二级菜单 (命中的分组优先; 子项命中时展开父二级) */
export function defaultOpenGroups(pathname: string): string[] {
  const m = matchNav(pathname);
  const open: string[] = ['workbench'];
  if (m) {
    if (m.group.id !== 'workbench') open.push(m.group.id);
    if (m.parent) open.push(m.parent.id);
  }
  return open;
}