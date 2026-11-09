'use client';
// LLM 用量看板 (2026-09-22): 让消耗可见。
// 飞轮 24h 932 次 CALL_LLM (实测 4.5M tokens), 99% 平台侧 MiniMax-M3, 没停 —— 没看板所以用户以为没转。
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零。
//   动态色（在转/停转、主色大数）→ data-tone 属性选择器；
//   动态宽/高（入口占比条、小时柱）→ 5% 一档的档位类 .pXX / .bhXX。
//   取数（/api/llm-usage 含顶栏时间范围）、文案、链接一字未改。
import LoadingBlock from "@/components/LoadingBlock";
import Link from "next/link";
import { useGlobalFilter } from '@/components/GlobalFilter';
import { useApi } from '@/lib/api';
import ErrorAlert from "@/components/ErrorAlert";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

interface Row { h: string; calls: number; tokens: number }
interface BucketResp { totalCalls: number; totalTokens: number; byEntry: Array<[string, { calls: number; tokens: number }]>; byModel: Array<[string, { calls: number; tokens: number }]>; byHour: Row[] }
// 2026-10-13 round 76-BZ: mind 侧新支持 opt-in 时间窗; 传了 range 才会带 window。
interface Resp { at: string; alive: boolean; last2hCalls: number; last24: BucketResp; last7: BucketResp; range?: string; rangeLabel?: string; window?: BucketResp }

/** 百分比 → 5% 一档的档位类（与 DataTable 骨架/占比同口径） */
function pctClass(p: number): string {
  const step = Math.min(100, Math.max(0, Math.round(p / 5) * 5));
  return styles["p" + step] || styles["p0"];
}
/** 柱高百分比 → 5% 一档的档位类 */
function barClass(p: number): string {
  const step = Math.min(100, Math.max(0, Math.round(p / 5) * 5));
  return styles["bh" + step] || styles["bh0"];
}

export default function LlmUsagePage() {
  // 2026-10-13 round 76-BZ: 接入顶栏时间范围(③)。该页原来完全无视全局筛选。
  const f = useGlobalFilter();
  // 2026-10-13 round 76-CD: 改用 useApi(pollMs: 0) —— 它自带**序号守卫**(只接受最新一次响应)与
  //   非 2xx 错误通道, 于是**不必再手写 fetch + alive 守卫**(76-CB 那版就是手写的, 因为当时 useApi 只会 10s 轮询)。
  //   pollMs: 0 = 只按需拉取(path 变化时重取: range/nonce)。
  const { data, error, loading, mutate } = useApi<Resp>('/api/llm-usage?range=' + f.range + '&_n=' + f.nonce, { pollMs: 0 });
  const err = error ? String((error as Error)?.message || error) : null;
  // 2026-11-06 D-03：页头不再写在「数据到了」之后的 return 里 —— 先定页头，再由 错误 / 加载 / 数据 决定正文。
  //   修前两个早返回只有错误块 / 骨架，首屏（含 SSR HTML）拿不到 page-header。
  //   标题、说明文案、取数（useApi）、错误块与加载骨架均未改。
  const header = (
    <PageHeader>
      <PageTitle>语言模型用量</PageTitle>
      <div className='page-subtitle'>实时观测量化引擎消耗与飞轮活跃度；第一张卡随顶栏"时间范围"变化，后两张固定 24 小时 / 7 天</div>
    </PageHeader>
  );
  if (err) return <main className='page'>{header}<ErrorAlert title="用量数据加载失败" message={err} onRetry={() => { mutate(); }} /></main>;
  if (loading || !data) return <main className='page'>{header}<LoadingBlock lines={4} label='语言模型用量加载中' /></main>;
  const lastByHour = data.last24.byHour;
  const maxC = lastByHour.reduce((m, r) => Math.max(m, r.calls), 1);
  return (
    <main className='page'>
      {header}
      <div className={styles.statGrid}>
        {data.window && <div className='panel'><div className='panel-header'><span className='panel-title'>所选范围（{data.rangeLabel || data.range}）</span></div>
          <div className={styles.bigValue} data-tone="primary">{data.window.totalCalls}</div>
          <div className='tiny'>含 {data.window.totalTokens.toLocaleString()} 个标记数 · 随顶栏时间范围变化</div></div>}
        <div className='panel'><div className='panel-header'><span className='panel-title'>飞轮状态（2 小时内）</span></div>
          <div className={styles.bigValue} data-tone={data.alive ? 'ok' : 'crit'}>{data.alive ? '● 在转' : '○ 停转'}</div>
          <div className='tiny'>最近 2 小时调用 {data.last2hCalls} 次</div></div>
        <div className='panel'><div className='panel-header'><span className='panel-title'>24 小时调用数</span></div>
          <div className={styles.bigValue}>{data.last24.totalCalls}</div>
          <div className='tiny'>含 {data.last24.totalTokens.toLocaleString()} 个标记数</div></div>
        <div className='panel'><div className='panel-header'><span className='panel-title'>7 天调用数</span></div>
          <div className={styles.bigValue}>{data.last7.totalCalls}</div>
          <div className='tiny'>含 {data.last7.totalTokens.toLocaleString()} 个标记数</div></div>
      </div>
      <div className='panel'><div className='panel-header'><span className='panel-title'>24 小时调用按入口</span></div>
        {data.last24.byEntry.map(([name, v]) => (
          <div key={name} className={styles.entryRow}>
            <div className={styles.entryName}>{name}</div>
            <div className={styles.entryTrack}>
              <div className={styles.entryFill + " " + pctClass((v.calls / data.last24.totalCalls) * 100)} />
            </div>
            <div className={styles.entryCalls}>{v.calls} 次</div>
            <div className={styles.entryTokens}>{v.tokens.toLocaleString()} 标记数</div>
          </div>
        ))}
      </div>
      <div className={styles.twoCols}>
        <div className='panel'><div className='panel-header'><span className='panel-title'>按模型</span></div>
          {data.last24.byModel.map(([m, v]) => (
            <div key={m} className={styles.modelRow}>
              <span className='mono'>{m}</span><span>{v.calls} 次 / {v.tokens.toLocaleString()} 标记数</span>
            </div>
          ))}</div>
        <div className='panel'><div className='panel-header'><span className='panel-title'>24 小时按小时</span></div>
          <div className={styles.bars}>
            {lastByHour.map((r) => (
              <div
                key={r.h}
                title={r.h + ' ' + r.calls + '次 / ' + r.tokens}
                className={styles.bar + " " + barClass((r.calls / maxC) * 100)}
                data-empty={r.calls ? undefined : "1"}
              />
            ))}
          </div>
          <div className={'tiny ' + styles.barHint}>每根柱为 1 小时，柱高=调用数</div></div>
      </div>
      {/* 2026-10-19 B5: 修前本页正文 0 条出链 ✗；补"相关视图"（每条都指向真实相关页, 非凑数）✓ */}
      <div className={"tiny " + styles.related}>
        <span>相关视图：</span>
        <Link href="/cost">成本视图 →</Link>
        <Link href="/flywheel/hard-metrics">飞轮硬指标 →</Link>
      </div>
    </main>
  );
}
