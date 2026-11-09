// 2026-09-14 全局搜索 (待办 todo_34742fd11df244cb856d):
// 平台页面/功能检索索引 —— 目标是"找功能不用记菜单在哪"。
//
// 约束 (由 scripts/test-global-search.cjs 守门):
//   1) 每一个 app/**/page.tsx 路由都必须有归宿:
//        - 左侧导航页   -> 从 NAV_GROUPS 自动纳入;
//        - 未进导航的详情页 -> 登记在 UTILITY_PAGES;
//        - 动态详情路由   -> 登记在 ENTITY_COVERED_ROUTES (由内容搜索直接跳实体详情)。
//   2) 文案一律走 i18n (t()), 不在此文件硬编码用户可见文字。
import { NAV_GROUPS } from './nav';
import { t } from '@/i18n';

export interface SearchPage {
  id: string;
  href: string;
  label: string;
  desc: string;
  icon: string;
  groupId: string;
  groupLabel: string;
  color: string;
  /** 额外检索词 (别名 / 场景词 / 输入法习惯词), 空格分隔, 仅用于匹配 */
  keywords: string;
  /** 详情/工具页: 正常从列表进入, 搜索结果里单独标注 */
  utility?: boolean;
}

/** 场景化别名: 用户想"干什么"时的说法 -> 页面 (只用于检索, 不展示) */
const KEYWORDS: Record<string, string> = {
  todo: '待办 行动项 决策 人审 我要做什么 审批 工单',
  home: '首页 总览 大盘 今日 概览 dashboard',
  daily: '每日 日报 总结 日历 历史',
  flywheel: '飞轮 看板 增长 质量 闭环',
  flow: '流程 流水线 步骤 运行图',
  audit: '记录 时间线 扫描 提炼 审计',
  logs: '日志 排错 报错 排查',
  tasks: '任务 改进 修复 机制',
  executions: '执行 明细 记录',
  reflections: '反思 聚合 主题 复盘',
  findings: '发现 问题 改进点 缺陷',
  coverage: '覆盖 覆盖率 范围',
  agents: '智能体 接入 能力 代理',
  agentsLive: '活跃 在线 卡住 实时 看板',
  onboard: '接入 向导 注册 新智能体 入门',
  approvals: '审批 密钥 发钥 通过',
  detail: '画像 档案 详情 资料',
  config: '配置 授权 业务 设置',
  transfer: '转移 接手 离开 继承 交接',
  sessionCenter: '会话中心 会话 对话 详情 列表',
  sessions: '会话 归档 档案 对话',
  sessionBrowser: '会话 浏览 查询 检索 对话',
  capabilities: '能力 技能 工具 服务',
  lineage: '血脉 血缘 来源 追踪 怎么来的',
  cognitive: '大脑 认知 记忆 知识 沉淀',
  memory: '记忆 记忆库 经验',
  knowledge: '知识 条目 文档 结论',
  reflection: '反思 教训 复盘',
  practice: '实践 模板 操作',
  skills: '技能 熟练度 能力',
  cost: '用量 花费 词元 模型 消耗 成本',
  system: '系统 总览 设置',
  systemApi: '接口 列表 服务',
  business: '业务 对接 系统',
  auth: '认证 登录 单点 鉴权',
  permissions: '权限 角色 授权 管控',
  comm: '通信 沟通 消息 联系',
  pipeline: '流水线 监控 运行历史',
  health: '健康 检查 数据库 完整性',
  accessLog: '访问 日志 作业 流水',
  automation: '自动化 定时 任务 调度',
  platformLogic: '逻辑 规则 说明 文档',
  auditOps: '运维 审计 入口',
};

/** 未登记在左侧导航的静态详情页 (仍需可搜索到) */
const UTILITY_PAGES: {
  id: string;
  href: string;
  icon: string;
  groupId: string;
  keywords: string;
}[] = [
  {
    id: 'knowledgeDetail',
    href: '/cognitive/knowledge/detail',
    icon: '📄',
    groupId: 'data',
    keywords: '知识 条目 详情',
  },
  {
    id: 'memoryDetail',
    href: '/cognitive/memory/detail',
    icon: '📄',
    groupId: 'data',
    keywords: '记忆 详情',
  },
  {
    id: 'reflectionDetail',
    href: '/cognitive/reflection/detail',
    icon: '📄',
    groupId: 'data',
    keywords: '反思 详情',
  },
  {
    id: 'practiceDetail',
    href: '/cognitive/practice/detail',
    icon: '📄',
    groupId: 'data',
    keywords: '实践 详情',
  },
  {
    id: 'skillDetail',
    href: '/cognitive/skills/detail',
    icon: '📄',
    groupId: 'data',
    keywords: '技能 详情',
  },

  // ── 2026-11-09 IA 重构（0.4.39-05）后不在 40 项导航里的页面：全部登记为可搜索的详情/子页 ──
  { id: 'agentsLive', href: '/agents-live', icon: 'activity', groupId: 'member', keywords: '' },
  { id: 'agentsOrg', href: '/agents/[id]/org', icon: '📄', groupId: 'member', keywords: '' },
  { id: 'agentsConfig', href: '/agents/config', icon: '📄', groupId: 'member', keywords: '' },
  { id: 'agentsDetail', href: '/agents/detail', icon: '📄', groupId: 'member', keywords: '' },
  { id: 'agentsSessionBrowser', href: '/agents/session-browser', icon: '📄', groupId: 'member', keywords: '' },
  { id: 'agentsSessions', href: '/agents/sessions', icon: '📄', groupId: 'member', keywords: '' },
  { id: 'auditOps', href: '/audit', icon: 'eye', groupId: 'board', keywords: '' },
  { id: 'daily', href: '/audit/daily-summary', icon: 'calendar', groupId: 'board', keywords: '' },
  { id: 'cognitive', href: '/cognitive', icon: 'cpu', groupId: 'data', keywords: '' },
  { id: 'cognitiveKnowledgeGovernance', href: '/cognitive/knowledge/governance', icon: '📄', groupId: 'data', keywords: '' },
  { id: 'cost', href: '/cost', icon: 'coins', groupId: 'board', keywords: '' },
  { id: 'flywheelBusiness', href: '/flywheel/business', icon: '📄', groupId: 'flywheel', keywords: '' },
  { id: 'flywheelBusinessDim', href: '/flywheel/business/[dim]', icon: '📄', groupId: 'flywheel', keywords: '' },
  { id: 'flywheelExecutions', href: '/flywheel/executions', icon: '📄', groupId: 'flywheel', keywords: '' },
  { id: 'flywheelFindings', href: '/flywheel/findings', icon: '📄', groupId: 'flywheel', keywords: '' },
  { id: 'flywheelImprovementResults', href: '/flywheel/improvement-results', icon: '📄', groupId: 'flywheel', keywords: '' },
  { id: 'learning', href: '/flywheel/learning', icon: 'sprout', groupId: 'flywheel', keywords: '' },
  { id: 'flywheelReflections', href: '/flywheel/reflections', icon: '📄', groupId: 'flywheel', keywords: '' },
  { id: 'flywheelTasksNew', href: '/flywheel/tasks/new', icon: '📄', groupId: 'flywheel', keywords: '' },
  { id: 'messagesFailed', href: '/messages/failed', icon: '📄', groupId: 'service', keywords: '' },
  { id: 'messagesManage', href: '/messages/manage', icon: 'folder', groupId: 'service', keywords: '' },
  { id: 'messagesSession', href: '/messages/session', icon: 'git-branch', groupId: 'service', keywords: '' },
  { id: 'sessionsDetail', href: '/sessions/detail', icon: '📄', groupId: 'service', keywords: '' },
  { id: 'system', href: '/system', icon: 'puzzle', groupId: 'platform', keywords: '' },
  { id: 'systemAccessLog', href: '/system/access-log', icon: '📄', groupId: 'platform', keywords: '' },
  { id: 'systemApi', href: '/system/api', icon: 'plug', groupId: 'platform', keywords: '' },
  { id: 'systemAssets', href: '/system/assets', icon: '📄', groupId: 'platform', keywords: '' },
  { id: 'systemAutomation', href: '/system/automation', icon: '📄', groupId: 'platform', keywords: '' },
  { id: 'systemBusiness', href: '/system/business', icon: '📄', groupId: 'platform', keywords: '' },
  { id: 'systemComm', href: '/system/comm', icon: '📄', groupId: 'platform', keywords: '' },
  { id: 'systemGuards', href: '/system/guards', icon: '📄', groupId: 'platform', keywords: '' },
  { id: 'observability', href: '/system/observability', icon: 'activity', groupId: 'platform', keywords: '' },
  { id: 'systemPermissions', href: '/system/permissions', icon: '📄', groupId: 'platform', keywords: '' },
  { id: 'systemRotation', href: '/system/rotation', icon: '📄', groupId: 'platform', keywords: '' },
  { id: 'versionBoard', href: '/system/version-board', icon: 'package', groupId: 'platform', keywords: '' },
  { id: 'terminalsDetail', href: '/terminals/detail', icon: '📄', groupId: 'toolbox', keywords: '' },
  { id: 'workbench', href: '/workbench', icon: '📄', groupId: 'board', keywords: '' },
];

/**
 * 动态详情路由: 没有实体 id 时无法直接打开, 因此不放进页面索引,
 * 而是由"内容搜索"命中实体后直接跳到 /flywheel/tasks/<id>。
 * 这里显式登记, 供覆盖率守门脚本核对 (避免"新增页面却搜不到"悄悄发生)。
 */
export const ENTITY_COVERED_ROUTES: string[] = ['/flywheel/tasks/[id]', '/agents/[id]', '/agents/[id]/overview', '/agents/[id]/config', '/agents/[id]/runs', '/agents/[id]/versions'];

const GROUP_BY_ID = new Map(NAV_GROUPS.map((g) => [g.id, { label: g.label, color: g.color }]));

/** 全量页面索引 = 左侧导航全部条目 + 未进导航的详情页 */
export const PAGE_INDEX: SearchPage[] = [
  ...NAV_GROUPS.flatMap((g) =>
    g.items.map((it) => ({
      id: it.id,
      href: it.href,
      label: it.label,
      desc: it.desc || '',
      icon: it.icon,
      groupId: g.id,
      groupLabel: g.label,
      color: g.color,
      keywords: KEYWORDS[it.id] || '',
      utility: it.utility,   // 2026-11-06: nav 页也可标"工具页"（如 /system/version-board）
    })),
  ),
  ...UTILITY_PAGES.map((p) => {
    const g = GROUP_BY_ID.get(p.groupId) || { label: p.groupId, color: '#64748b' };
    return {
      id: p.id,
      href: p.href,
      label: t(`search.page.${p.id}.label`),
      desc: t(`search.page.${p.id}.desc`),
      icon: p.icon,
      groupId: p.groupId,
      groupLabel: g.label,
      color: g.color,
      keywords: p.keywords,
      utility: true,
    };
  }),
];

function norm(s: string): string {
  return String(s || '')
    .toLowerCase()
    .trim();
}

/** 单页匹配打分: 精确 > 前缀 > 标题包含 > 别名 > 描述 > 分组 > 路径 */
function scorePage(p: SearchPage, q: string): number {
  const label = norm(p.label);
  const desc = norm(p.desc);
  const kw = norm(p.keywords);
  const group = norm(p.groupLabel);
  const href = norm(p.href);
  if (label === q) return 100;
  if (label.startsWith(q)) return 92;
  if (label.includes(q)) return 82;
  if (kw.split(/\s+/).some((w) => w === q)) return 74;
  if (kw.includes(q)) return 64;
  if (desc.includes(q)) return 52;
  if (group.includes(q)) return 36;
  if (href.includes(q)) return 28;
  return 0;
}

/**
 * 页面检索。
 * @param query 关键词 (空串 = 返回全部页面, 供面板首屏浏览)
 * @param limit 最多返回条数
 */
export function searchPages(query: string, limit = 8): SearchPage[] {
  const q = norm(query);
  if (!q) return PAGE_INDEX.slice(0, limit);
  return PAGE_INDEX.map((p) => ({ p, s: scorePage(p, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.label.length - b.p.label.length)
    .slice(0, limit)
    .map((x) => x.p);
}

/** 按分组聚合 (面板首屏浏览用) */
export function pagesByGroup(): { groupLabel: string; color: string; pages: SearchPage[] }[] {
  const order: string[] = NAV_GROUPS.map((g) => g.id);
  const map = new Map<string, { groupLabel: string; color: string; pages: SearchPage[] }>();
  for (const p of PAGE_INDEX) {
    if (!map.has(p.groupId))
      map.set(p.groupId, { groupLabel: p.groupLabel, color: p.color, pages: [] });
    map.get(p.groupId)!.pages.push(p);
  }
  return order.filter((id) => map.has(id)).map((id) => map.get(id)!);
}
