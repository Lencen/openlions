import { NextResponse } from "next/server";
import { readCatalog } from "@/lib/server/model-config-status";

export const dynamic = "force-dynamic";

/**
 * GET /api/model-config/catalog —— provider/model 下拉数据源（基线 §依赖清单 ①）。
 *
 * 三源合并：hermes config.yaml providers / openclaw models.providers /（dsh 默认模型不在此列）。
 * 硬约束：
 *   1) discover_models=false 的供应商**必须原样列出 models**，否则切换会打到未登记模型
 *      -> 404 UnsupportedModel（派单点名 xiaomi-cn / xiaomi / minimax-cn / ark 等）；
 *   2) 只回 provider id / 名称 / 地址 / 协议 / 模型 id —— **任何 apiKey 一律不读不回传**；
 *   3) 读不到 -> ok:false + 中文原因（页面显示 n/a + 原因，不编造）。
 */
export async function GET() {
  try {
    const { providers, asOf, reason } = readCatalog();
    if (reason) return NextResponse.json({ ok: false, error: reason, providers: [], asOf }, { status: 503 });
    return NextResponse.json({ ok: true, providers, asOf, count: providers.length });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "模型目录读取失败", detail: String((e as Error)?.message || e).slice(0, 160), providers: [] },
      { status: 500 }
    );
  }
}
