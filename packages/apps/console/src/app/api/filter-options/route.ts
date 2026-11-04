import { NextResponse } from "next/server";
import { asOf, openMind, q, safeClose } from "@/lib/server/lions-db";
import { macsAdminKey } from "@/lib/server/macs-admin";

export const dynamic = "force-dynamic";

// 2026-10-15（round 76-GH）**性能修复**：这个接口以前**每次请求**都跑一个
//   `Memory UNION ALL Knowledge` 的 `GROUP BY theme` —— 而这两张表约 **18.5 万行**
//   (实测 Memory 99,990 / Knowledge 85,591) -> **每次全表扫描 + 分组**, 实测 5.9~**12.8 秒** ✗。
//   而它是**外壳级**接口(全局筛选条的下拉), **每一页都要调一次** ✗ ——
//   等于把 6~13 秒摊到全站每一次页面加载上。
//   修法: **进程内缓存 + 10 分钟 TTL**。筛选选项(智能体名册 / 主题词)极少变 ✓,
//         过期时**同步重算一次**(此后 10 分钟内所有页面都是 0 成本) ✓。
//   注意: asOf 与缓存**一起存** ✓ —— 它必须如实表示"这批选项是**什么时候算出来的**" ✓,
//         不能用"这次请求的时间"(那会让"数据时刻"说谎 ✗)。
type FilterOptions = { asOf: string; agents: any[]; themes: string[] };
// 2026-10-15（round 76-GL）**缓存位置修正**：
//   76-GH 我用的是**模块级变量** `let cache = null`。76-GK 实测发现：
//     浏览器连开 4 个页面时，响应序列是 hit,hit,miss,hit,miss,hit,miss,hit —— **每次导航后的第一个请求都 miss** ✗；
//     而 curl 稳态连打 10 次是 **10/10 hit** ✓。
//   两者放一起指向：**dev 会按路由重新实例化模块，模块级变量随之丢失** ✓。
//   修法：把缓存**挂到 globalThis** ✓ —— 它在"同一进程内跨模块重载"存活 ✓（Next dev 的常规做法）。
//   （多进程部署仍是每进程一份，这一点 76-GH 已披露；本改动只解决"同进程内被重编译清掉"✗。）
const G = globalThis as unknown as { __lionsFilterOptionsCache?: { at: number; data: FilterOptions } };
const CACHE_TTL_MS = 10 * 60 * 1000;

// GET /api/filter-options — 全局筛选栏的可选项 (Agent / 主题)
// 只读 + 容错: mind 库打不开或 MACS 不可达时返回空数组, 绝不 500。
export async function GET() {
  const hit = G.__lionsFilterOptionsCache;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json(hit.data, { headers: { "X-Filter-Options": "hit" } });
  }
  const mind = openMind();
  const agents: { value: string; label: string; online?: boolean }[] = [];
  const themes: string[] = [];
  try {
    const rows = await q(
      mind,
      "SELECT agent_id, display_name, status FROM AgentRegistry ORDER BY status ASC, agent_id ASC"
    );
    for (const r of rows) {
      if (!r?.agent_id) continue;
      agents.push({
        value: r.agent_id,
        label: r.display_name ? `${r.display_name} (${r.agent_id})` : r.agent_id,
        online: r.status === "ACTIVE",
      });
    }

    const themeRows = await q(
      mind,
      "SELECT theme, SUM(c) c FROM (" +
        "SELECT theme, COUNT(*) c FROM Memory WHERE theme IS NOT NULL AND theme <> '' GROUP BY theme " +
        "UNION ALL " +
        "SELECT theme, COUNT(*) c FROM Knowledge WHERE theme IS NOT NULL AND theme <> '' GROUP BY theme" +
        ") GROUP BY theme ORDER BY c DESC LIMIT 80"
    );
    for (const r of themeRows) if (r?.theme) themes.push(String(r.theme));
  } catch {
    /* ignore */
  }

  // MACS 在线状态 (带超时, 不可达则忽略)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    // 2026-10-27(macs-backend-2): MACS_SECURITY_ENFORCE=1 下 /api/agents 需要 x-api-key；
    // 裸 fetch 会被 401（实测 33 次 MISSING_KEY），页面静默降级成"没有 agent"。
    const res = await fetch("http://localhost:8765/api/agents", {
      cache: "no-store",
      signal: ctrl.signal,
      headers: { "x-api-key": macsAdminKey() },
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const list: any[] = Array.isArray(data?.agents) ? data.agents : [];
      const seen = new Set(agents.map((a) => a.value));
      for (const a of list) {
        const id = a?.agent_id;
        if (!id) continue;
        const online = a?.status === "online";
        const found = agents.find((x) => x.value === id);
        if (found) {
          if (online || found.online === undefined) found.online = online;
        } else if (!seen.has(id)) {
          seen.add(id);
          agents.push({ value: id, label: a.display_name ? `${a.display_name} (${id})` : id, online });
        }
      }
    }
  } catch {
    /* MACS 不可达: 仅用 mind 注册表 */
  }

  // 在线优先排序
  agents.sort((a, b) => Number(!!b.online) - Number(!!a.online) || a.value.localeCompare(b.value));
  safeClose(mind);
  const payload = { asOf: asOf(), agents, themes };
  G.__lionsFilterOptionsCache = { at: Date.now(), data: payload };
  return NextResponse.json(payload, { headers: { "X-Filter-Options": "miss" } });
}