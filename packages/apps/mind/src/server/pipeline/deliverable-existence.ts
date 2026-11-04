/**
 * deliverable-existence.ts — 假完成防线: 「说做了」必须对应「真有东西」(2026-09-15)
 *
 * 为什么需要(实测 3 起, 其中一起就是"假完成防线"这张单自己):
 *   执行体提交任务时只写"已完成", 平台就把任务置 DONE, 并把来源待办**自动结单**;
 *   而实测待办里点名要的产出(scripts/acceptance/selftest-integrate.sh 之类)**根本不存在**,
 *   结单证据还是与本单无关的通用话术。用户看到的就是"活没干, 单却结了"。
 *
 * 口径(宁漏不误, 逐条可测):
 *   - 只认**带目录的路径**(含 "/" 且有常见扩展名), 裸文件名不认(裸名太容易误伤);
 *   - 只在任务的 description / requirements / acceptanceCriteria 里出现过的路径才算"被声明的交付物";
 *   - 行内如果出现"读/参考/见/依据/read/see/reference"这类**引用语境**, 该路径视为输入而非产出, 不判缺;
 *   - 路径带 glob(*)、占位符(<>)、URL、.. 一律忽略;
 *   - 绝对路径直接检, 相对路径按仓库根解析(env LIONS_REPO, 默认 " + (process.env.LIONS_HOME || process.cwd()) + " 与 cwd 都试);
 *   - 一个路径都没抽到 -> 返回空数组, **不拦**(不把"没写路径"误判成假完成)。
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

/** 常见交付物扩展名(与仓库实际产出对齐: 代码/脚本/文档/数据/页面) */
export const DELIVERABLE_EXT = "ts|tsx|js|cjs|mjs|json|sh|md|py|sql|html|css|yml|yaml";

/** 引用语境: 命中的行里, 路径前面若出现这些词, 说明是"要参考/读取的输入", 不是产出 */
const REFERENCE_HINTS = /(读|参考|参照|见|依据|输入|样例|模板|模仿|对齐|read|see|refer|based on|existing)/i;

/** 交付语境: 出现这些词时, 即使同一行有引用词, 也仍按"产出"对待 */
const DELIVERABLE_HINTS = /(交付物|产出|新增|创建|落地|提交|实现|补上|写出|生成|验收标准|必须存在|deliverable)/i;

/** 从一段文字里抽出被声明的交付物路径(去重、有序) */
export function extractDeclaredPaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // 允许以 "/" 开头的绝对路径(执行体常写全路径), 但要求前面是行首或分隔符 —— 这样 http://a/b.md 不会被抓成 "b.md"。
  const re = new RegExp("(?:^|[\\s`'\\(\"\\[{])(\\/?[A-Za-z0-9_][A-Za-z0-9_./-]*\\/[A-Za-z0-9_.-]+\\.(?:" + DELIVERABLE_EXT + "))(?![A-Za-z0-9])", "g");
  for (const line of String(text ?? "").split("\n")) {
    const isReferenceOnly = REFERENCE_HINTS.test(line) && !DELIVERABLE_HINTS.test(line);
    if (isReferenceOnly) continue;
    for (const m of line.matchAll(re)) {
      const p = m[1];
      if (p.includes("..") || p.includes("*") || p.includes("<") || p.includes(">") || p.includes("{") || p.includes("$")) continue;
      if (/^https?:\/\//.test(p) || /^\d+\.\d+\.\d+\.\d+/.test(p)) continue;
      if (p.length > 200) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export type DeliverableCheck = {
  /** 任务正文里被声明的交付物(去重后) */
  declared: string[];
  /** 其中找不到的(按声明顺序, 最多 8 条) */
  missing: string[];
};

/**
 * 仓库文件清单(用于**后缀解析**)。
 *
 * 为什么必须做后缀解析(实测数据说话): 只按仓库根检, 近 168h 会拦下 582/14656 条任务(4.0%),
 *   但明细里绝大多数是**局部路径**——执行体写的是「pipeline/index.ts」「health/page.tsx」这种
 *   相对某个子目录的写法, 文件其实真实存在(如 packages/apps/mind/src/server/pipeline/index.ts)。
 *   不做后缀解析 = 大面积误伤, 防线会因为"太吵"被人关掉, 等于没有。
 *   做法: 声明路径要么按根/绝对路径直接命中, 要么在仓库清单里存在"以 /声明路径 结尾"的文件 -> 算存在。
 * 清单来源: git ls-files(含未跟踪但未忽略的文件), 60s 缓存, 避免每次提交都跑一遍。
 */
const inventoryCache = new Map<string, { at: number; files: string[] }>();
export function repoInventory(root: string): string[] {
  const now = Date.now();
  const key = path.resolve(root);
  const cached = inventoryCache.get(key);
  // 缓存必须**按根**分桶: 回归用例先用临时目录(无 git)探过, 若全进程共用一个槽, 真实仓库会被空清单污染。
  if (cached && now - cached.at < 60_000) return cached.files;
  let files: string[] = [];
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15_000,
    });
    files = out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { files = []; }
  inventoryCache.set(key, { at: now, files });
  return files;
}

/** 清缓存(测试用) */
export function resetInventoryCache() { inventoryCache.clear(); }

/** 判定一组路径是否在仓库里存在(直接命中 或 后缀命中) */
export function missingAmong(declared: string[], roots?: string[], opts?: { suffix?: boolean }): string[] {
  const bases = roots && roots.length ? roots : [process.env.LIONS_REPO || "" + (process.env.LIONS_HOME || process.cwd()) + "", process.cwd()];
  const useSuffix = opts?.suffix !== false;
  const inv = useSuffix ? repoInventory(bases[0]) : [];
  const invSet = new Set(inv);
  const missing: string[] = [];
  for (const p of declared) {
    let hit = false;
    for (const base of bases) {
      try {
        const abs = path.isAbsolute(p) ? p : path.join(base, p);
        if (fs.existsSync(abs)) { hit = true; break; }
      } catch { /* 路径非法 -> 当作不存在 */ }
    }
    if (!hit && useSuffix) {
      const suffix = "/" + p.replace(/^\.\//, "");
      hit = invSet.has(p) || inv.some((f) => f.endsWith(suffix));
    }
    if (!hit) missing.push(p);
  }
  return missing;
}

/**
 * 任务声明过的交付物里, 哪些不存在。
 * 返回空数组 = 不拦(要么都真存在, 要么任务压根没声明路径)。
 */
/**
 * 仓库顶层条目(用于「只认从仓库顶层写起的路径」这条口径)。
 * 为什么(实测): 回放近 168h, 只做后缀解析仍会拦 361 条 —— 明细里大量是
 *   ① 别的仓库/机器的路径(src/pipeline-engine.js、lions-mind/src/...、/usr/local/lib/node.js、/tmp/xxx.sh)
 *   ② finding 正文里的举例占位(scripts/xxx.ts)
 *   这些都不该判本单的"缺"。所以再加一条: 相对路径的**第一段必须是本仓库的顶层条目**(packages/scripts/docs/tests/...),
 *   绝对路径**必须落在仓库内**。剩下的才当交付物 —— 宁可漏判, 不可乱拦(乱拦的防线会被关掉, 等于没有)。
 */
const topLevelCache = new Map<string, Set<string>>();
export function repoTopLevel(root: string): Set<string> {
  const key = path.resolve(root);
  const hit = topLevelCache.get(key);
  if (hit) return hit;
  const set = new Set<string>();
  for (const f of repoInventory(root)) {
    const seg = f.split("/")[0];
    if (seg) set.add(seg);
  }
  try {
    for (const e of fs.readdirSync(root)) set.add(e); // git 不可用时(临时目录测试)兜底
  } catch { /* 目录不可读 -> 空集 */ }
  topLevelCache.set(key, set);
  return set;
}

/** 这个路径是不是"本仓库的交付物"(相对路径要顶层锚定; 绝对路径要落在仓库内) */
export function isRepoDeliverable(p: string, bases: string[]): boolean {
  if (path.isAbsolute(p)) return bases.some((b) => { try { return path.resolve(p).startsWith(path.resolve(b) + path.sep); } catch { return false; } });
  const seg = p.replace(/^\.\//, "").split("/")[0];
  return bases.some((b) => repoTopLevel(b).has(seg));
}

export function checkDeclaredArtifacts(
  task: { description?: unknown; requirements?: unknown; acceptanceCriteria?: unknown },
  roots?: string[],
  opts?: { suffix?: boolean; repoAnchored?: boolean }
): DeliverableCheck {
  const bases = roots && roots.length ? roots : [process.env.LIONS_REPO || "" + (process.env.LIONS_HOME || process.cwd()) + "", process.cwd()];
  const text = [task?.description, task?.requirements, task?.acceptanceCriteria].map((s) => String(s ?? "")).join("\n");
  const all = extractDeclaredPaths(text);
  const declared = opts?.repoAnchored === false ? all : all.filter((p) => isRepoDeliverable(p, bases));
  const missing = missingAmong(declared, roots, opts);
  return { declared, missing: missing.slice(0, 8) };
}

/** 兼容旧调用: 只要缺失清单 */
export function missingDeclaredArtifacts(
  task: { description?: unknown; requirements?: unknown; acceptanceCriteria?: unknown },
  roots?: string[],
  opts?: { suffix?: boolean }
): string[] {
  try {
    return checkDeclaredArtifacts(task, roots, opts).missing;
  } catch {
    return [];
  }
}
