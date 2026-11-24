// /market — 服务端入口（2026-11-19 F6/B-01）：读 ?state= 并把强制态交给客户端组件，
//   目的：SSR 首屏即为强制态（curl / 截图 / 判据都能判定），不再依赖 hydrate 后的 window.location。
//   只做参数转发，页面逻辑与渲染全部留在 MarketPage。
import MarketPage from "./MarketClient";
import { parseForcedState } from "@/lib/forced-state";

export const dynamic = "force-dynamic";

export default function Page({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  return <MarketPage forcedState={parseForcedState(searchParams)} />;
}
