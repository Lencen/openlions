// 2026-11-09 IA 重构（0.4.39-05，商业线裁决口径）：7 组 40 项（27 一级 + 13 二级）。
//   事实源：docs/design/uiux-bento-2026-11/nav-mapping.json（40 项）+ docs/productization/CONSOLE-IA-BENTO-2026-11-04.md
//   改版要点：
//     1) 分组从 9-21 版 7 组（工作台/会话与协同/智能体/认知资产/飞轮/业务系统/平台管理）
//        改为目标 7 组：看板 / 成员 / 飞轮 / 数据 / 工具箱 / 服务 / 平台；
//     2) 补 tools、terminals 入口（页面早已建好，此前菜单与全局搜索都没有入口，只能手输 URL）；
//     3) 3 处合并收敛：业务看板(/market，/flywheel/business 已 301)、运维看板(/system/health，
//        /cost 与 /audit 不再各占菜单)、会话管理(/sessions，/messages/session 不再是独立菜单项)；
//     4) 4 个目标页尚未建（/agents/groups、/tools/mcp、/docs、/about）先以 locked 渲染占位，
//        不放进菜单可点项（避免死链），待页面建好去掉 locked 即上线；
//     5) 组内条目均 <=8（导航要求），详情页仍不占菜单。
//   历史：2026-09-21 版「模块只占一级、详情走 Tab」的原则不变；本次只改分组与条目集合。
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

/** 分组定义 (文案 key 集中登记在 zh-CN.ts / en-US.ts) */
const GROUP_DEFS: { id: string; labelKey: string; color: string }[] = [
  { id: 'board', labelKey: 'nav.group.board', color: 'var(--text-dim)' },
  { id: 'member', labelKey: 'nav.group.member', color: 'var(--text-dim)' },
  { id: 'flywheel', labelKey: 'nav.group.flywheel', color: 'var(--text-dim)' },
  { id: 'data', labelKey: 'nav.group.data', color: 'var(--text-dim)' },
  { id: 'toolbox', labelKey: 'nav.group.toolbox', color: 'var(--text-dim)' },
  { id: 'service', labelKey: 'nav.group.service', color: 'var(--text-dim)' },
  { id: 'platform', labelKey: 'nav.group.platform', color: 'var(--text-dim)' },
];

/** 条目定义: 40 项 = 27 一级 + 13 二级 — 文案 key = nav.item.<id>.label/desc */
const ITEM_DEFS: { group: string; id: string; href?: string; icon: string; badge?: 'new'; utility?: boolean; children?: { id: string; href: string; icon: string }[]; locked?: boolean }[] = [
  // -- 看板（4 项）--
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'board', id: 'overview', href: '/', icon: 'dashboard', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'board', id: 'business', href: '/market', icon: 'store', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'board', id: 'ops', href: '/system/health', icon: 'activity', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'board', id: 'todo', href: '/todo', icon: 'check-square', },

  // -- 成员（3 项）--
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'member', id: 'agents', href: '/agents', icon: 'bot', children: [ { id: 'approvals', href: '/agents/approvals', icon: 'clipboard' }, { id: 'capabilities', href: '/agents/capabilities', icon: 'cpu' }, { id: 'agentKeys', href: '/agents/keys', icon: 'dot' }, { id: 'onboard', href: '/agents/onboard', icon: 'rocket' }, { id: 'transfer', href: '/agents/transfer', icon: 'rotate' } ], },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'member', id: 'org', href: '/agents/org', icon: 'building', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'member', id: 'groups', href: '/agents/groups', icon: 'sprout', },

  // -- 飞轮（2 项）--
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'flywheel', id: 'flywheel', href: '/flywheel', icon: 'refresh', children: [ { id: 'flow', href: '/flywheel/flow', icon: 'refresh' }, { id: 'coverage', href: '/flywheel/coverage', icon: 'bar-chart' }, { id: 'flywheelAudit', href: '/flywheel/audit', icon: 'dot' }, { id: 'hardMetrics', href: '/flywheel/hard-metrics', icon: 'trending-up' }, { id: 'llmUsage', href: '/flywheel/llm-usage', icon: 'activity' }, { id: 'logs', href: '/flywheel/logs', icon: 'file-text' } ], },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'flywheel', id: 'ftasks', href: '/flywheel/tasks', icon: 'clipboard', },

  // -- 数据（6 项）--
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'data', id: 'memory', href: '/cognitive/memory', icon: 'cpu', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'data', id: 'knowledge', href: '/cognitive/knowledge', icon: 'book', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'data', id: 'reflection', href: '/cognitive/reflection', icon: 'message-dots', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'data', id: 'skills', href: '/cognitive/skills', icon: 'target', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'data', id: 'practice', href: '/cognitive/practice', icon: 'wrench', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'data', id: 'lineage', href: '/lineage', icon: 'git-branch', },

  // -- 工具箱（4 项）--
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'toolbox', id: 'tools', href: '/tools', icon: 'cone', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'toolbox', id: 'mcp', href: '/tools/mcp', icon: 'plug', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'toolbox', id: 'terminal', href: '/terminals', icon: 'rocket', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'toolbox', id: 'design', href: '/design', icon: 'puzzle', },

  // -- 服务（4 项）--
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'service', id: 'sessions', href: '/sessions', icon: 'message-square', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'service', id: 'macs', href: '/messages', icon: 'mail', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'service', id: 'docs', href: '/docs', icon: 'file-text', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'service', id: 'devops', href: '/system/pipeline', icon: 'rotate', },

  // -- 平台（4 项）--
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'platform', id: 'config', href: '/platform/logic', icon: 'compass', children: [ { id: 'platformModel', href: '/platform/model', icon: 'dot' }, { id: 'platformOps', href: '/platform/ops', icon: 'dot' } ], },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'platform', id: 'auth', href: '/system/auth', icon: 'shield-check', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'platform', id: 'client', href: '/system/client-releases', icon: 'package', },
  // ia-ok: 0.4.39-05 IA 重构（商业线 2026-11-09 裁决 40 项）：按 nav-mapping 落地的模块级入口，详情走 Tab/深链，不占菜单
  { group: 'platform', id: 'about', href: '/about', icon: 'heart', },
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
  const open: string[] = ['board'];
  if (m) {
    if (m.group.id !== 'workbench') open.push(m.group.id);
    if (m.parent) open.push(m.parent.id);
  }
  return open;
}