'use client';
// LLM 用量看板 (2026-09-22): 让消耗可见。
// 飞轮 24h 932 次 CALL_LLM (实测 4.5M tokens), 99% 平台侧 MiniMax-M3, 没停 —— 没看板所以用户以为没转。
import { Alert } from '@/components/primitives';
import LoadingBlock from "@/components/LoadingBlock";
import Link from "next/link";
import { useGlobalFilter } from '@/components/GlobalFilter';
import { useApi } from '@/lib/api';
import ErrorAlert from "@/components/ErrorAlert";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";

interface Row { h: string; calls: number; tokens: number }
interface BucketResp { totalCalls: number; totalTokens: number; byEntry: Array<[string, { calls: number; tokens: number }]>; byModel: Array<[string, { calls: number; tokens: number }]>; byHour: Row[] }
// 2026-10-13 round 76-BZ: mind 侧新支持 opt-in 时间窗; 传了 range 才会带 window。
interface Resp { at: string; alive: boolean; last2hCalls: number; last24: BucketResp; last7: BucketResp; range?: string; rangeLabel?: string; window?: BucketResp }

export default function LlmUsagePage() {
  // 2026-10-13 round 76-BZ: 接入顶栏时间范围(③)。该页原来完全无视全局筛选。
  const f = useGlobalFilter();
  // 2026-10-13 round 76-CD: 改用 useApi(pollMs: 0) —— 它自带**序号守卫**(只接受最新一次响应)与
  //   非 2xx 错误通道, 于是**不必再手写 fetch + alive 守卫**(76-CB 那版就是手写的, 因为当时 useApi 只会 10s 轮询)。
  //   pollMs: 0 = 只按需拉取(path 变化时重取: range/nonce)。
  const { data, error, loading, mutate } = useApi<Resp>('/api/llm-usage?range=' + f.range + '&_n=' + f.nonce, { pollMs: 0 });
  const err = error ? String((error as Error)?.message || error) : null;
  if (err) return <main className='page'><ErrorAlert title="用量数据加载失败" message={err} onRetry={() => { mutate(); }} /></main>;
  if (loading || !data) return <main className='page'><LoadingBlock lines={4} label='语言模型用量加载中' /></main>;
  const lastByHour = data.last24.byHour;
  const maxC = lastByHour.reduce((m, r) => Math.max(m, r.calls), 1);
  return (
    <main className='page'>
      <PageHeader><PageTitle>语言模型用量</PageTitle>
        <div className='page-subtitle'>实时观测量化引擎消耗与飞轮活跃度；第一张卡随顶栏"时间范围"变化，后两张固定 24 小时 / 7 天</div></PageHeader>
      <div style={{ display: 'grid', gap: "var(--sp-3)", gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: "var(--sp-4)" }}>
        {data.window && <div className='panel'><div className='panel-header'><span className='panel-title'>所选范围（{data.rangeLabel || data.range}）</span></div>
          <div style={{ fontSize: "var(--fs-3xl)", fontWeight: 700, color: 'var(--primary)' }}>{data.window.totalCalls}</div>
          <div className='tiny'>含 {data.window.totalTokens.toLocaleString()} 个标记数 · 随顶栏时间范围变化</div></div>}
        <div className='panel'><div className='panel-header'><span className='panel-title'>飞轮状态（2 小时内）</span></div>
          <div style={{ fontSize: "var(--fs-3xl)", fontWeight: 700, color: data.alive ? 'var(--status-ok)' : 'var(--status-crit)' }}>{data.alive ? '● 在转' : '○ 停转'}</div>
          <div className='tiny'>最近 2 小时调用 {data.last2hCalls} 次</div></div>
        <div className='panel'><div className='panel-header'><span className='panel-title'>24 小时调用数</span></div>
          <div style={{ fontSize: "var(--fs-3xl)", fontWeight: 700 }}>{data.last24.totalCalls}</div>
          <div className='tiny'>含 {data.last24.totalTokens.toLocaleString()} 个标记数</div></div>
        <div className='panel'><div className='panel-header'><span className='panel-title'>7 天调用数</span></div>
          <div style={{ fontSize: "var(--fs-3xl)", fontWeight: 700 }}>{data.last7.totalCalls}</div>
          <div className='tiny'>含 {data.last7.totalTokens.toLocaleString()} 个标记数</div></div>
      </div>
      <div className='panel'><div className='panel-header'><span className='panel-title'>24 小时调用按入口</span></div>
        {data.last24.byEntry.map(([name, v]) => (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: "var(--sp-2)", fontSize: "var(--fs-base)", padding: '3px 0' }}>
            <div style={{ width: 220, fontFamily: 'var(--font-mono)' }}>{name}</div>
            <div style={{ flex: 1, background: 'var(--bg-surface2)', borderRadius: "var(--radius-xs)", overflow: 'hidden', height: 14, position: 'relative' }}>
              <div style={{ width: ((v.calls / data.last24.totalCalls) * 100) + '%', height: '100%', background: 'var(--primary)' }} />
            </div>
            <div style={{ width: 90, textAlign: 'right' }}>{v.calls} 次</div>
            <div style={{ width: 120, textAlign: 'right', color: 'var(--text-dim)' }}>{v.tokens.toLocaleString()} 标记数</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: "var(--sp-3)", display: 'grid', gap: "var(--sp-3)", gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <div className='panel'><div className='panel-header'><span className='panel-title'>按模型</span></div>
          {data.last24.byModel.map(([m, v]) => (
            <div key={m} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: "var(--fs-base)" }}>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{m}</span><span>{v.calls} 次 / {v.tokens.toLocaleString()} 标记数</span>
            </div>
          ))}</div>
        <div className='panel'><div className='panel-header'><span className='panel-title'>24 小时按小时</span></div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: "var(--sp-0-5)", height: 80, padding: '4px 0' }}>
            {lastByHour.map((r) => (
              <div key={r.h} title={r.h + ' ' + r.calls + '次 / ' + r.tokens} style={{ flex: 1, background: 'var(--primary)', height: ((r.calls / maxC) * 100) + '%', minHeight: r.calls ? 2 : 0, borderRadius: "var(--radius-xs)", opacity: r.calls ? 1 : 0.2 }} />
            ))}
          </div>
          <div className='tiny' style={{ marginTop: "var(--sp-1)" }}>每根柱为 1 小时，柱高=调用数</div></div>
      </div>
      {/* 2026-10-19 B5: 修前本页正文 0 条出链 ✗；补"相关视图"（每条都指向真实相关页, 非凑数）✓ */}
      <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
        <span>相关视图：</span>
        <Link href="/cost">成本视图 →</Link>
        <Link href="/flywheel/hard-metrics">飞轮硬指标 →</Link>
      </div>
    </main>
  );
}