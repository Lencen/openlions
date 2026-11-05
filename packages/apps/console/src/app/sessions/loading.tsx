import { StateBlock } from "@/components/ui";

/** /sessions 的加载态（服务端 force-dynamic，没有客户端 loading 标志）：
 *  Next 的 route-level loading.tsx 就是本页的四态之一，用白名单 StateBlock 的 loading 分支渲染骨架行。 */
export default function Loading() {
  return (
    <div className="layout-with-sidebar">
      <main className="main">
        <StateBlock loading rows={8} />
      </main>
    </div>
  );
}
