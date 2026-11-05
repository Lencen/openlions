'use client';
// 2026-09-14 全局搜索 (待办 todo_34742fd11df244cb856d):
// 顶部 Ctrl/⌘+K 命令面板 —— 输入关键词即可跳转任意页面/功能, 并顺手检索平台内容实体
// (知识 / 记忆 / 反思 / 实践 / 技能 / 待办 / 改进任务 / 智能体)。
// 设计: 页面结果本地即时算 (无网络等待), 内容结果防抖后走 /api/global-search。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import Icon from "@/components/Icon";
import styles from "./GlobalSearch.module.css";
import { t } from '@/i18n';
import { SearchPage, searchPages, pagesByGroup } from '@/config/searchIndex';

interface EntityHit {
  id: string;
  title: string;
  snippet: string;
  href: string;
}
interface EntityGroup {
  kind: string;
  items: EntityHit[];
}

interface Row {
  key: string;
  href: string;
  icon: string;
  title: string;
  subtitle: string;
  tag?: string;
  utility?: boolean;
}
interface Section {
  key: string;
  label: string;
  color: string;
  rows: Row[];
}

/** 分组点颜色只来自导航配置的三个设计令牌；其它一律按最淡处理。 */
const DOT_TONE: Record<string, string> = {
  "var(--primary)": "primary",
  "var(--table-memory)": "memory",
  "var(--text-dim)": "dim",
};
const dotTone = (color: string) => DOT_TONE[color] ?? "dim";

function toRow(p: SearchPage): Row {
  return {
    key: `page:${p.href}:${p.id}`,
    href: p.href,
    icon: p.icon,
    title: p.label,
    subtitle: p.desc,
    utility: p.utility,
  };
}

/** 关键词高亮 (大小写不敏感) */
function Highlight({ text, keyword }: { text: string; keyword: string }) {
  const q = keyword.trim();
  if (!q) return <>{text}</>;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = String(text).split(new RegExp(`(${esc})`, 'ig'));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === q.toLowerCase() ? (
          <mark className="gs-hl" key={i}>
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export default function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [entities, setEntities] = useState<EntityGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [isMac, setIsMac] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform || ''));
  }, []);

  const openPanel = useCallback(() => {
    setOpen(true);
    setKeyword('');
    setEntities([]);
    setActive(0);
  }, []);
  const closePanel = useCallback(() => setOpen(false), []);

  // —— 快捷键 ——
  // 2026-10-22：⌘K 交给全站 CommandPalette（唯一入口），这里只保留 "/" 打开本搜索，
  //   避免两处监听互相抢焦点（此前在 /messages 上行为不稳定）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing) return;
      if (e.key === '/') {
        e.preventDefault();
        setOpen(true);
        setKeyword('');
        setEntities([]);
        setActive(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 打开后自动聚焦输入框
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  // —— 内容检索 (防抖 180ms, 可取消) ——
  useEffect(() => {
    if (!open) return;
    const q = keyword.trim();
    if (!q) {
      setEntities([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const id = window.setTimeout(() => {
      fetch(`/api/global-search?q=${encodeURIComponent(q)}&limit=6`, {
        signal: ctrl.signal,
        cache: 'no-store',
      })
        .then((r) => r.json())
        .then((d) => {
          setEntities(Array.isArray(d?.groups) ? d.groups : []);
          setLoading(false);
        })
        .catch((e) => {
          if (e?.name !== 'AbortError') setLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(id);
      ctrl.abort();
    };
  }, [keyword, open]);

  // —— 组装结果区 ——
  const sections: Section[] = useMemo(() => {
    const q = keyword.trim();
    const out: Section[] = [];
    if (!q) {
      for (const g of pagesByGroup()) {
        out.push({
          key: `g:${g.groupLabel}`,
          label: g.groupLabel,
          color: g.color,
          rows: g.pages.map(toRow),
        });
      }
      return out;
    }
    const pageHits = searchPages(q, 8);
    if (pageHits.length) {
      out.push({
        key: 'pages',
        label: t('search.groupPages'),
        color: 'var(--primary)',
        rows: pageHits.map(toRow),
      });
    }
    for (const eg of entities) {
      if (!eg.items?.length) continue;
      out.push({
        key: `e:${eg.kind}`,
        label: t(`search.kind.${eg.kind}`),
        color: 'var(--table-memory)',
        rows: eg.items.map((it) => ({
          key: `e:${eg.kind}:${it.id}`,
          href: it.href,
          icon: 'git-branch',
          title: it.title,
          subtitle: it.snippet,
        })),
      });
    }
    return out;
  }, [keyword, entities]);

  const flat: Row[] = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  // 结果变化时把高亮复位到第一条
  useEffect(() => {
    setActive(0);
  }, [keyword]);

  // 高亮项滚动到可视区
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, sections]);

  const go = useCallback(
    (row?: Row) => {
      const target = row || flat[active];
      if (!target) return;
      setOpen(false);
      router.push(target.href);
    },
    [flat, active, router],
  );

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const total = flat.length;

  return (
    <>
      <button
        type="button"
        className="gs-trigger"
        onClick={openPanel}
        title={t('search.triggerTip')}
        aria-label={t('search.triggerTip')}
      >
        <Icon name="search" size={16} />
        <span className="gs-trigger-text">{t('search.trigger')}</span>
        <kbd className="gs-kbd">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

      <Modal
        open={open}
        onCancel={closePanel}
        footer={null}
        closable={false}
        centered
        width={660}
        maskClosable
        className={styles.modal}
      >
        <div className="gs-modal" role="dialog" aria-modal="true" aria-label={t('search.trigger')}>
          <div className="gs-search">
            <span className="gs-search-icon" aria-hidden="true">
              🔍
            </span>
            <input
              ref={inputRef}
              className="gs-input"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={onInputKey}
              placeholder={t('search.placeholder')}
              aria-label={t('search.placeholder')}
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="gs-esc">ESC</kbd>
          </div>

          <div className="gs-list" ref={listRef}>
            {total === 0 ? (
              <div className="gs-empty">
                <div className="gs-empty-title">{t('search.empty')}</div>
                <div className="gs-empty-hint">{t('search.emptyHint')}</div>
              </div>
            ) : (
              <>
                {!keyword.trim() ? (
                  <div className="gs-browse-head">{t('search.groupRecent')}</div>
                ) : null}
                {sections.map((sec) => (
                  <div className="gs-group" key={sec.key}>
                    <div className="gs-group-title">
                      <span className={"gs-group-dot " + styles.dot} data-tone={dotTone(sec.color)} />
                      {sec.label}
                    </div>
                    {sec.rows.map((row) => {
                      const idx = flat.indexOf(row);
                      return (
                        <div
                          key={row.key}
                          data-idx={idx}
                          className={'gs-item' + (idx === active ? ' active' : '')}
                          onMouseEnter={() => setActive(idx)}
                          onClick={() => go(row)}
                          role="button"
                          tabIndex={-1}
                        >
                          <span className="gs-item-icon" aria-hidden="true">
                            <Icon name={row.icon} size={16} />
                          </span>
                          <span className="gs-item-main">
                            <span className="gs-item-title">
                              <Highlight text={row.title} keyword={keyword} />
                              {row.utility ? (
                                <span className="gs-item-tag">{t('search.utilityTag')}</span>
                              ) : null}
                            </span>
                            {row.subtitle ? (
                              <span className="gs-item-desc">
                                <Highlight text={row.subtitle} keyword={keyword} />
                              </span>
                            ) : null}
                          </span>
                          {idx === active ? (
                            <span className="gs-item-enter" aria-hidden="true">
                              ↵
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </>
            )}
            {loading && <div className="gs-loading">{t('search.searching')}</div>}
          </div>

          <div className="gs-footer">
            <span>{t('search.footerHint')}</span>
            <span className="gs-count">{total ? t('search.resultCount', { n: total }) : ''}</span>
          </div>
        </div>
      </Modal>
    </>
  );
}
