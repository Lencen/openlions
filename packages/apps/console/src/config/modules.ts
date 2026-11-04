// 2026-09-14 文案业务化: 模块名走集中文案 (src/i18n), 页面不硬编码。
import { t } from '@/i18n';

export interface PlatformModule {
  id: string;
  label: string;
  color: string;
  href: string;
}

export const PLATFORM_MODULES: PlatformModule[] = [
  // 2026-09-01 平台化重构 (P2 IA): 平台管理中枢
  { id: 'overview', label: t('module.overview'), color: 'var(--primary)', href: '/' },
  { id: 'agents', label: t('module.agents'), color: 'var(--table-memory)', href: '/agents' },
  { id: 'cognitive', label: t('module.cognitive'), color: 'var(--table-knowledge)', href: '/cognitive' },
  { id: 'flywheel', label: t('module.flywheel'), color: 'var(--status-warn)', href: '/flywheel' },
  { id: 'system', label: t('module.system'), color: 'var(--status-crit)', href: '/system' },
  { id: 'audit', label: t('module.audit'), color: '#64748b', href: '/audit' },
];
