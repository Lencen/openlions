// 2026-11-02（前端团队 B2/B3）：**版本号的唯一读取处**。
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
  /** 当前部署平台版本（/opt/lions/current/VERSION 或 LIONS_VERSION）；开发树运行时用于侧栏“平台服务”展示 */
  deployedPlatform: string | null;
  deployedSource: string | null;
  platformSource: string;
  consolePackage: string | null;
  /** 本机**实际安装**的客户端版本（/usr/lib/lions-client/CLIENT_VERSION）；读不到时回落到发布包声明值 */
  clientPackage: string | null;
  /** clientPackage 的取值来源：installed | declared | null（用于区分「实装」与「仅声明」） */
  clientPackageSource: "installed" | "declared" | null;
  /** 平台发布包**声明**的客户端版本（releases/<ver>/CLIENT_VERSION 或仓库根）；只供核对，不参与判定 */
  declaredClientPackage: string | null;
  gitSha: string;
  gitDirty: boolean;
  processStartedAt: string;
  /** 当前运行产物 .next/BUILD_ID（0.5.1 起；用于确认"构建是否已生效"） */
  buildId: string | null;
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
  const repoPlatform = readTrim(path.join(root, "VERSION")) || "unknown";
  const envPlatform = String(process.env.LIONS_VERSION || "").trim();
  const deployedPlatform = envPlatform || readTrim("/opt/lions/current/VERSION");
  const deployedSource = deployedPlatform ? (envPlatform ? "env:LIONS_VERSION" : "/opt/lions/current/VERSION") : null;
  const platform = repoPlatform;
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
  // 2026-11-23（[team]）：clientPackage 改为**实装优先** —— 修的是「读数取错源」，不是改语义。
  // 病（实测 2026-11-23 11:0x）：/api/version 报 clientPackage=2026.11.14.13，而本机实装的是 2026.11.23.01。
  // 根因就下面这一行：root 解析成 /opt/lions/releases/0.6.6-pg（该目录里有 CLIENT_VERSION=2026.11.14.13），
  //   `A || B` 中 A 非空即短路 -> /usr/lib/lions-client/CLIENT_VERSION 永远读不到，实装值被声明值永久遮蔽。
  // 为什么改成实装优先：clientPackage 回答的问题是「这台机器上**实际在跑**的客户端是哪一版」，
  //   那是运维/排障要的答案；发布包声明的那一版是另一个事实（该发布包**配**哪一版）。
  //   两者不同时正是最该被看见的信号，所以保留 declaredClientPackage 并给出 clientPackageSource，
  //   而不是把声明值算作「客户端版本」——那样 2026.11.14.13 会一直冒充实装值（AGENTS 19 同族：读数假装成功）。
  const declaredClientPkg = readTrim(path.join(root, "CLIENT_VERSION"));
  const installedClientPkg = readTrim("/usr/lib/lions-client/CLIENT_VERSION");
  const clientPkg = installedClientPkg || declaredClientPkg;
  const clientPkgSource: "installed" | "declared" | null = installedClientPkg ? "installed" : (declaredClientPkg ? "declared" : null);
  const { sha, dirty } = gitInfo(root);
  const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
  // 闭环判据（不是"永远相等"的空断言）：只要有人只改一处，这里立刻转红并说明是哪一处。
  const issues: string[] = [];
  if (!platform || platform === "unknown") issues.push("仓库根 VERSION 缺失或不可读");
  if (!consolePkg) issues.push("packages/apps/console/package.json 版本不可读");
  else if (consolePkg !== platform) issues.push(`平台版本 ${platform} ≠ 控制台包版本 ${consolePkg}（改版本时必须同步这两处）`);
  return {
    platform,
    deployedPlatform: deployedPlatform || null,
    deployedSource,
    platformSource: path.join(root, "VERSION"),
    consolePackage: consolePkg,
    clientPackage: clientPkg,
    clientPackageSource: clientPkgSource,
    declaredClientPackage: declaredClientPkg,
    gitSha: sha,
    gitDirty: dirty,
    processStartedAt: startedAt,
    buildId: readTrim(path.join(cwd, ".next", "BUILD_ID")) || readTrim(path.join(root, "packages/apps/console/.next/BUILD_ID")),
    readAt: new Date().toISOString(),
    consistent: issues.length === 0,
    issues,
  };
}