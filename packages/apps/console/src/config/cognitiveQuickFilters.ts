// 2026-09-14 UI-7 (待办 todo_7ef17821bac447368a40): 认知大表「常用筛选」的界面能力表。
//
// 四个快捷筛选的**判定口径在后端** packages/apps/mind/src/server/lib/cognitive-quick-filter.ts;
// 这里只声明"哪张表提供哪些入口 + 文案 key"，文案走集中 i18n (见 src/i18n/messages/zh-CN.ts)。
//
// 注意: 反思表没有质量分字段, 因此不提供"高质量"入口 (反射用"待复核"低置信口径兜底)。
import { t } from '@/i18n';

export type QuickFilterKey = 'highQuality' | 'recent7d' | 'referenced' | 'pendingReview';
export type CognitiveTableKey = 'memory' | 'knowledge' | 'practice' | 'reflection' | 'skill';

export interface QuickFilterOption {
  key: QuickFilterKey;
  label: string;
  tip: string;
}

const APPLICABLE: Record<CognitiveTableKey, QuickFilterKey[]> = {
  memory: ['highQuality', 'recent7d', 'referenced', 'pendingReview'],
  knowledge: ['highQuality', 'recent7d', 'referenced', 'pendingReview'],
  practice: ['highQuality', 'recent7d', 'referenced', 'pendingReview'],
  reflection: ['recent7d', 'referenced', 'pendingReview'], // 无质量分
  skill: ['highQuality', 'recent7d', 'referenced', 'pendingReview'],
};

const TIP_KEYS: Record<QuickFilterKey, string> = {
  highQuality: 'quick.highQuality.tip',
  recent7d: 'quick.recent7d.tip',
  referenced: 'quick.referenced.tip',
  pendingReview: 'quick.pendingReview.tip',
};

const LABEL_KEYS: Record<QuickFilterKey, string> = {
  highQuality: 'quick.highQuality.label',
  recent7d: 'quick.recent7d.label',
  referenced: 'quick.referenced.label',
  pendingReview: 'quick.pendingReview.label',
};

export function getQuickFilters(table: CognitiveTableKey): QuickFilterOption[] {
  return APPLICABLE[table].map((key) => {
    // "待复核" 各表口径不同 -> 优先取表专属说明, 缺省回退通用说明
    const tipKey = key === 'pendingReview' ? `quick.pendingReview.tip.${table}` : TIP_KEYS[key];
    return { key, label: t(LABEL_KEYS[key]), tip: t(tipKey) };
  });
}
