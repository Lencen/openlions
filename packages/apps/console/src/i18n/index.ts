// 2026-09-14 文案业务化 (待办 todo_c0c8aee4ca134af0b5ed):
// 界面文案统一入口 —— t() 取词 + 业务化术语 (bizTerm / bizText)。
//
// 设计目标:
//   1) 集中管理: 文案都放 src/i18n/messages/<locale>.ts, 页面只引用 key;
//   2) 多语言就绪: locale 可切换, 缺词自动回退到 zh-CN, 不出现空白;
//   3) 业务化: 技术词 -> 业务说法 的对照表在 src/i18n/glossary.ts, 供展示层归一。
import { zhCN } from './messages/zh-CN';
import { enUS } from './messages/en-US';

export const DEFAULT_LOCALE = 'zh-CN' as const;
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const CATALOG: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

let currentLocale: Locale = DEFAULT_LOCALE;

/** 切换当前语言 (后续多语言入口: 顶部或配置里调用) */
export function setLocale(locale: string): Locale {
  currentLocale = (SUPPORTED_LOCALES as readonly string[]).includes(locale)
    ? (locale as Locale)
    : DEFAULT_LOCALE;
  return currentLocale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export interface TVars {
  [key: string]: string | number | null | undefined;
}

/**
 * 取文案: t('nav.item.todo.label')
 * - 支持 {name} 占位插值: t('x.y', { n: 3 })
 * - 当前语言缺词 -> 回退 zh-CN -> 再回退 key 本身 (便于发现漏登记)
 */
export function t(key: string, vars?: TVars): string {
  const raw = CATALOG[currentLocale]?.[key] ?? CATALOG[DEFAULT_LOCALE][key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) =>
    vars[name] === undefined || vars[name] === null ? m : String(vars[name])
  );
}

export { TERM_GLOSSARY, TERM_MAP, bizTerm, bizText } from './glossary';
export type { GlossaryEntry } from './glossary';
