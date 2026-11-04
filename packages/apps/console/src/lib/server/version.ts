// 2026-11-02（前端线 B2/B3）：**版本号的唯一读取处**。
// 背景：页面顶栏/侧栏曾写死 "v0.3.0"，而代码包是 0.1.0、装上去的又是 0.1.1 —— 三个号并存，
//      客户和我们都没法据此判断"跑的是哪一版"（见 WEEKLY-REVIEW-2026-W44 §B2/B3）。
// 口径（B3 版本闭环）：
//   · 平台版本 = 仓库根 VERSION 文件（**唯一源**，lions-pack / lions-install 都读它）
//   · 控制台包版本 = packages/apps/console/package.json（参考值，不再对外当"平台版本"）
//   · gitSha / gitDirty = 该进程当前目录所属仓库的提交与脏标记（可复算"这是哪份代码"）
//   · processStartedAt = 本进程启动时刻（区分"改了代码但没生效"）
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export type VersionInfo = {
  platform: string;
  platformSource: string;
  consolePackage: string | null;
  clientPackage: string | null;
  gitSha: string;
  gitDirty: boolean;
  processStartedAt: string;
  readAt: string;
  /** B3 版本闭环判据：平台版本与控制台包版本必须一致；不一致时这里为 false 且 issues 给出原因 */
  consistent: boolean;
  issues: string[];
};

// 2026-11-02 实测教训：最初这里把整份 VersionInfo 缓存进模块级变量 —— 结果**故意把 package.json 改成
// 0.4.1 后判据仍然是绿的**（模块不重载，缓存永远返回旧值），正是"先写后比永远相等"的空判据。
// 现在只缓存 git 调用（3 秒，避免每次请求都起子进程），版本文件每次请求都重读。
let gitCache: { at: number; sha: string; dirty: boolean } | null = null;

function findUp(start: string, marker: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return "";
}

function readTrim(p: string): string | null {
  try {
    const v = fs.readFileSync(p, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

function gitInfo(root: string): { sha: string; dirty: boolean } {
  if (gitCache && Date.now() - gitCache.at < 3000) return { sha: gitCache.sha, dirty: gitCache.dirty };
  const sha = git(root, "rev-parse --short HEAD");
  const dirty = git(root, "status --porcelain") !== "";
  gitCache = { at: Date.now(), sha, dirty };
  return { sha, dirty };
}

function git(root: string, args: string): string {
  try {
    return execSync("git " + args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 }).trim();
  } catch {
    return "";
  }
}

export function readVersionInfo(): VersionInfo {
  const cwd = process.cwd();
  // 2026-11-02 试点实测：B1 搬到"成品目录"后，app 目录不再位于 packages/apps/console，
  // 于是 <root>/packages/apps/console/package.json 找不到 -> 版本判据当场转红（这是对的，但需自愈）。
  // 现在两种布局都支持：仓库布局（VERSION 在仓库根）与发布布局（VERSION 在 releases/<ver>/ 下，app 是其子目录）。
  const root =
    findUp(cwd, "VERSION") ||
    findUp(path.dirname(cwd), "VERSION") ||
    findUp(cwd, ".git") ||
    cwd;
  const platform = readTrim(path.join(root, "VERSION")) || "unknown";
  const consolePkg = (() => {
    const candidates = [path.join(root, "packages/apps/console/package.json"), path.join(cwd, "package.json"), path.join(root, "package.json")];
    for (const p of candidates) {
      try {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (j?.version) return String(j.version);
      } catch { /* 试下一个布局 */ }
    }
    return null;
  })();
  const clientPkg = readTrim(path.join(root, "CLIENT_VERSION")) || readTrim("/usr/lib/lions-client/CLIENT_VERSION");
  const { sha, dirty } = gitInfo(root);
  const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
  // 闭环判据（不是"永远相等"的空断言）：只要有人只改一处，这里立刻转红并说明是哪一处。
  const issues: string[] = [];
  if (!platform || platform === "unknown") issues.push("仓库根 VERSION 缺失或不可读");
  if (!consolePkg) issues.push("packages/apps/console/package.json 版本不可读");
  else if (consolePkg !== platform) issues.push(`平台版本 ${platform} ≠ 控制台包版本 ${consolePkg}（改版本时必须同步这两处）`);
  return {
    platform,
    platformSource: path.join(root, "VERSION"),
    consolePackage: consolePkg,
    clientPackage: clientPkg,
    gitSha: sha,
    gitDirty: dirty,
    processStartedAt: startedAt,
    readAt: new Date().toISOString(),
    consistent: issues.length === 0,
    issues,
  };
}
