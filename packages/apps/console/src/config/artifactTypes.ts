// 2026-09-14 文案业务化 (待办 todo_c0c8aee4ca134af0b5ed) 复核增补:
// 认知产物实体 (记忆 / 知识 / 实践 / 技能) 的技术名 -> 业务说法 + 元数据。
//
// 约束:
//   1) 界面上不出现 Knowledge / Memory / Practice / Skill 等内部实体名, 一律经 artifactLabel() 取业务说法;
//   2) SQL 列名 / 表名等纯技术信息只在此处维护, 不散落到页面或 API 路由里硬编码;
//   3) 业务说法本身集中在 src/i18n/messages/<locale>.ts, 本文件只保留"技术名 -> 文案 key"的骨架,
//      以支持后续多语言。
import { t } from '@/i18n';

export const ARTIFACT_META = {
  Memory: { labelKey: 'common.memory', titleCol: 'COALESCE(title, substr(content,1,50))' },
  Knowledge: { labelKey: 'common.knowledge', titleCol: 'title' },
  Practice: { labelKey: 'common.practice', titleCol: 'title' },
  Skill: { labelKey: 'common.skill', titleCol: 'name' },
} as const;

export type ArtifactType = keyof typeof ARTIFACT_META;

/** 全部产物类型 (避免在页面里再手写一份实体名数组) */
export const ARTIFACT_TYPES = Object.keys(ARTIFACT_META) as ArtifactType[];

/** 默认产物类型 (接口 type 参数缺省时使用) */
export const DEFAULT_ARTIFACT_TYPE: ArtifactType = 'Knowledge';

export function isArtifactType(value: string): value is ArtifactType {
  return Object.prototype.hasOwnProperty.call(ARTIFACT_META, value);
}

/**
 * 展示用实体 (含反思): 界面上出现的 5 类认知实体。
 * 反思不是"产物表"查询目标 (故不入 ARTIFACT_META), 但界面列表 / 图表里会出现,
 * 必须给业务说法, 否则界面上会漏出 "Reflection"。
 */
const ENTITY_LABEL_KEY: Record<string, string> = {
  Memory: 'common.memory',
  Knowledge: 'common.knowledge',
  Practice: 'common.practice',
  Skill: 'common.skill',
  Reflection: 'common.reflection',
  // 飞轮主题反思表 (FlywheelReflection) 也是界面上会出现的实体名, 业务说法 "主题反思"
  FlywheelReflection: 'cognitive.reflection.title',
};

/**
 * 大小写归一索引: 后端返回 / 图表数据里常出现小写形态 (memory / knowledge / reflection),
 * 统一在此归一, 避免每个页面各自手写一份大小写映射 (又会散落硬编码)。
 */
const ENTITY_ALIAS: Record<string, string> = Object.fromEntries(
  Object.keys(ENTITY_LABEL_KEY).map((k) => [k.toLowerCase(), k])
);

/** 全部展示用实体类型 (顺序固定, 供图表 / 表格列复用) */
export const ENTITY_TYPES = ['Memory', 'Knowledge', 'Practice', 'Skill', 'Reflection'] as const;

/**
 * 实体技术名 -> 业务说法 (含反思与主题反思); 大小写不敏感; 未知类型原样返回 (兜底)。
 * 未知类型原样返回是刻意的: 宁可漏出原文, 也不要瞎翻译。
 */
export function entityLabel(type: string): string {
  const key = ENTITY_LABEL_KEY[type] ?? ENTITY_LABEL_KEY[ENTITY_ALIAS[type.toLowerCase()] ?? ''];
  return key ? t(key) : type;
}

/** 技术名 -> 业务说法; 未知类型原样返回 (兜底) */
export function artifactLabel(type: string): string {
  if (isArtifactType(type)) return t(ARTIFACT_META[type].labelKey);
  return entityLabel(type);
}

/** 取该产物表用于展示标题的列表达式 */
export function artifactTitleCol(type: ArtifactType): string {
  return ARTIFACT_META[type].titleCol;
}

/** 业务说法列表, 用于报错/提示文案 (如 "记忆 / 知识 / 实践 / 技能") */
export function artifactLabelList(): string {
  return ARTIFACT_TYPES.map((x) => artifactLabel(x)).join(' / ');
}
