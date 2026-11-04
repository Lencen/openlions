// 2026-09-15 文案业务化 (待办 todo_c0c8aee4ca134af0b5ed) 复核增补:
// 系统状态页 / 健康检查页的**服务名**与**飞轮健康维度**的技术名 -> 业务说法。
//
// 约束:
//   1) 页面上不出现 Session / completion / dataMath 这类技术名, 一律经 serviceLabel() /
//      healthDimLabel() 取业务说法;
//   2) 业务说法本身集中在 src/i18n/messages/<locale>.ts, 本文件只保留"技术名 -> 文案 key"
//      的骨架, 以支持后续多语言;
//   3) 未知技术名原样返回 (宁可漏出原文, 也不瞎翻译)。
import { t } from '@/i18n';

/** 服务技术名 -> 文案 key (服务名同时出现在 system 状态页与 health 检查页, 共用一个映射) */
const SERVICE_LABEL_KEY: Record<string, string> = {
  Mind: 'service.mind',
  Selfimproving: 'service.selfimproving',
  SI: 'service.selfimproving', // health 页历史上写作 SI, 归一为同一业务说法
  Session: 'service.session',
  Console: 'service.console',
  Portal: 'service.portal',
};

/** 飞轮健康维度技术名 -> 文案 key */
const HEALTH_DIM_LABEL_KEY: Record<string, string> = {
  completion: 'health.completion',
  runtime: 'health.runtime',
  logic: 'health.logic',
  dataMath: 'health.dataMath',
  structure: 'health.structure',
  quality: 'health.quality',
  overall: 'health.overall',
};

/** 服务技术名 -> 业务说法; 未知服务名原样返回 */
export function serviceLabel(name: string): string {
  const key = SERVICE_LABEL_KEY[name];
  return key ? t(key) : name;
}

/** 飞轮健康维度技术名 -> 业务说法; 未知维度原样返回 */
export function healthDimLabel(key: string): string {
  const labelKey = HEALTH_DIM_LABEL_KEY[key];
  return labelKey ? t(labelKey) : key;
}

/** 状态枚举技术值 -> 文案 key (各页面不再直接渲染 PROCESSED / PENDING / FAILED 等英文值) */
const STATUS_LABEL_KEY: Record<string, string> = {
  OK: 'status.ok',
  ACTIVE: 'status.active',
  PENDING: 'status.pending',
  PROCESSED: 'status.processed',
  COMPLETED: 'status.completed',
  DONE: 'status.done',
  FAILED: 'status.failed',
  IN_PROGRESS: 'status.inProgress',
  REVOKED: 'status.revoked',
  SKIPPED: 'status.skipped',
  SUCCESS: 'status.success',
  PARTIAL: 'status.partial',
  RUNNING: 'status.running',
  SCHEDULED: 'status.scheduled',
  // 2026-10-19 B3: 补上实测会出现的枚举（原先缺键 -> 原样漏出英文 ✗）
  OPEN: 'status.open',
  DOING: 'status.inProgress',   // 复用既有"进行中"，不新造词 ✓
  BLOCKED: 'status.blocked',
  DROPPED: 'status.dropped',
  DEPRECATED: 'status.deprecated',
  STOPPED: 'status.stopped',
  ONLINE: 'status.online',
  OFFLINE: 'status.offline',
};

/** 状态枚举值 -> 业务说法; 未知状态原样返回 (宁可漏出原文, 也不瞎翻译) */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return '';
  const key = STATUS_LABEL_KEY[status];
  return key ? t(key) : status;
}

// 2026-10-19 B3: **来源类型**枚举也会裸渲染成英文（实测 /system/pipeline、/system/automation 的 sourceType 列
//   出现 MANUAL / AUTO / CLAUDE_CONVERSATION）。措辞**照抄**既有 BFF 映射(src/app/api/lineage-detail/route.ts)，
//   不新造词；未知值原样返回 ✓。
const SOURCE_TYPE_LABEL: Record<string, string> = {
  CLAUDE_CONVERSATION: "来自 Claude 会话提炼 (会话消息 → LLM 抽取)",
  PIPELINE_HERMES: "来自 hermes 渠道会话的流水线提炼",
  PIPELINE_BACKFILL: "来自历史会话回填 (批量补提炼)",
  FLYWHEEL_REFLECTION: "来自飞轮主题反思 (跨会话聚合)",
  FLYWHEEL_STRUCTURED: "来自改进任务执行后的结构化回填",
  BRIDGE: "来自任务产物桥接回写",
  GLOBAL_ORGANIZER: "来自全局整理器 (知识地图/知识点归并)",
  AGENT_OUTPUT: "来自 Agent 主动提交的产出",
  PLATFORM_GUIDE: "平台自带指南内容",
  PLATFORM_SPEC: "平台自带规范内容",
  LEARNED: "平台学习产物 (由反思/结构化任务合成)",
  MANUAL: "人工录入",
  IMPORTED: "外部导入",
  LEGACY: "历史遗留数据 (迁移导入)",
  UNKNOWN: "来源未标注",
};

/** 来源类型枚举 -> 业务说法; 未知值原样返回 */
export function sourceTypeLabel(v: string | null | undefined): string {
  if (!v) return '';
  return SOURCE_TYPE_LABEL[v] ?? v;
}

// 2026-10-19 B3: **运行模式**枚举同样被裸渲染（实测 /system/pipeline 的"模式"列显示 MANUAL / AUTO）
const RUN_MODE_LABEL: Record<string, string> = {
  MANUAL: '手动触发',
  AUTO: '自动触发',
  CRON: '定时触发',
  SCHEDULED: '定时触发',
};

/** 运行模式枚举 -> 业务说法; 未知值原样返回 */
export function runModeLabel(v: string | null | undefined): string {
  if (!v) return '';
  return RUN_MODE_LABEL[v] ?? v;
}
