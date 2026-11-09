// 2026-09-14 文案业务化: 子模块卡片文案走集中文案 (src/i18n), 不硬编码。
import { t } from '@/i18n';

export interface Submodule {
  module: string;
  id: string;
  label: string;
  icon: string;
  perm: string;
  href: string;
  desc: string;
  priority: 'P0' | 'P1' | 'P2';
  isNew?: boolean;
  locked?: boolean;
  stats?: { label: string; value: string | number }[];
}

/** 定义: 只保留结构字段; 文案由 copyKey 从 zh-CN.ts 取 */
interface SubDef {
  module: string;
  id: string;
  copyKey: string;
  icon: string;
  perm: string;
  href: string;
  priority: 'P0' | 'P1' | 'P2';
  isNew?: boolean;
  locked?: boolean;
  stats?: { label: string; value: string | number }[];
}

const DEFS: SubDef[] = [
  // Tab 2: 记忆与知识 (7 页)
  { module: 'cognitive', id: 'memory', copyKey: 'memory', icon: 'cpu', perm: 'core.memory', href: '/cognitive/memory', priority: 'P0' },
  { module: 'cognitive', id: 'memory-detail', copyKey: 'memory-detail', icon: '📄', perm: 'core.memory', href: '/cognitive/memory/detail', priority: 'P1', isNew: true },
  { module: 'cognitive', id: 'knowledge', copyKey: 'knowledge', icon: 'book', perm: 'core.knowledge', href: '/cognitive/knowledge', priority: 'P0' },
  { module: 'cognitive', id: 'reflection', copyKey: 'reflection', icon: 'lightbulb', perm: 'core.reflection', href: '/cognitive/reflection', priority: 'P1' },
  { module: 'cognitive', id: 'practice', copyKey: 'practice', icon: 'wrench', perm: 'core.practice', href: '/cognitive/practice', priority: 'P1' },
  { module: 'cognitive', id: 'skills', copyKey: 'skills', icon: 'target', perm: 'core.skill', href: '/cognitive/skills', priority: 'P1' },

  // Tab 4: 智能体与能力 (7 页)
  { module: 'agents', id: 'onboard', copyKey: 'onboard', icon: 'rocket', perm: 'agents.onboard', href: '/agents/onboard', priority: 'P0', isNew: true },
  { module: 'agents', id: 'approvals', copyKey: 'approvals', icon: 'shield-check', perm: 'agents.onboard', href: '/agents/approvals', priority: 'P0', isNew: true },
  { module: 'agents', id: 'detail', copyKey: 'detail', icon: 'users', perm: 'agents.detail', href: '/agents/detail', priority: 'P0', isNew: true },
  { module: 'agents', id: 'transfer', copyKey: 'transfer', icon: 'refresh', perm: 'agents.transfer', href: '/agents/transfer', priority: 'P1', isNew: true },
  { module: 'agents', id: 'sessions', copyKey: 'sessions', icon: 'message-square', perm: 'agents.sessions', href: '/agents/sessions', priority: 'P1' },
  { module: 'agents', id: 'session-browser', copyKey: 'session-browser', icon: 'search', perm: 'agents.sessions', href: '/agents/session-browser', priority: 'P1', isNew: true },
  { module: 'agents', id: 'capabilities', copyKey: 'capabilities', icon: 'wrench', perm: 'agents.capabilities', href: '/agents/capabilities', priority: 'P1' },

  // Tab 5: 业务与系统 (9 页)
  { module: 'system', id: 'api', copyKey: 'api', icon: 'plug', perm: 'system.api', href: '/system/api', priority: 'P0', isNew: true },
  { module: 'system', id: 'business', copyKey: 'business', icon: 'clipboard', perm: 'system.business', href: '/system/business', priority: 'P1', isNew: true },
  { module: 'system', id: 'auth', copyKey: 'auth', icon: 'lock', perm: 'system.auth', href: '/system/auth', priority: 'P1', isNew: true },
  { module: 'system', id: 'permissions', copyKey: 'permissions', icon: 'shield', perm: 'system.permissions', href: '/system/permissions', priority: 'P1', isNew: true },
  { module: 'system', id: 'pipeline', copyKey: 'pipeline', icon: 'git-branch', perm: 'system.pipeline', href: '/system/pipeline', priority: 'P1' },
  { module: 'system', id: 'health', copyKey: 'health', icon: 'heart', perm: 'system.health', href: '/system/health', priority: 'P1' },
  { module: 'system', id: 'access-log', copyKey: 'access-log', icon: 'file-text', perm: 'audit.access', href: '/system/access-log', priority: 'P2' },
  { module: 'system', id: 'automation', copyKey: 'automation', icon: 'settings', perm: 'audit.automation', href: '/system/automation', priority: 'P2', isNew: true },
  // 2026-10-13 round 76-BM: mind /rotation 搬进 console
  { module: 'system', id: 'rotation', copyKey: 'rotation', icon: 'rotate', perm: 'audit.automation', href: '/system/rotation', priority: 'P2', isNew: true },

  // Tab 6: 飞轮引擎 (6 页)
  { module: 'flywheel', id: 'overview', copyKey: 'flywheel-overview', icon: 'refresh', perm: 'flywheel.overview', href: '/flywheel', priority: 'P0' },
  { module: 'flywheel', id: 'flow', copyKey: 'flow', icon: 'settings', perm: 'flywheel.flow', href: '/flywheel/flow', priority: 'P0', isNew: true },
  { module: 'flywheel', id: 'audit', copyKey: 'audit', icon: 'clipboard', perm: 'flywheel.audit', href: '/flywheel/audit', priority: 'P0', isNew: true },
  { module: 'flywheel', id: 'logs', copyKey: 'logs', icon: 'file-text', perm: 'flywheel.logs', href: '/flywheel/logs', priority: 'P1', isNew: true },
  { module: 'flywheel', id: 'tasks', copyKey: 'tasks', icon: 'check-square', perm: 'flywheel.tasks', href: '/flywheel/tasks', priority: 'P1' },
  { module: 'flywheel', id: 'reflections', copyKey: 'reflections', icon: 'lightbulb', perm: 'flywheel.reflections', href: '/flywheel/reflections', priority: 'P1' },
  { module: 'flywheel', id: 'findings', copyKey: 'findings', icon: 'search', perm: 'flywheel.findings', href: '/flywheel/findings', priority: 'P2' },
  { module: 'flywheel', id: 'coverage', copyKey: 'coverage', icon: 'trending-up', perm: 'flywheel.coverage', href: '/flywheel/coverage', priority: 'P2' },

  // Tab 7: 审计
  { module: 'audit', id: 'daily-summary', copyKey: 'daily-summary', icon: 'calendar', perm: 'audit.daily', href: '/audit/daily-summary', priority: 'P0', isNew: true },
];

export const SUBMODULES: Submodule[] = DEFS.map((d) => ({
  module: d.module,
  id: d.id,
  label: t(`sub.${d.copyKey}.label`),
  icon: d.icon,
  perm: d.perm,
  href: d.href,
  desc: t(`sub.${d.copyKey}.desc`),
  priority: d.priority,
  isNew: d.isNew,
  locked: d.locked,
}));

export function getSubmodules(moduleId: string): Submodule[] {
  return SUBMODULES.filter(s => s.module === moduleId);
}
