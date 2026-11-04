// MindClient SDK 1.0
// 2026-06-06 SHARED-BRAIN-V2 (lions-mind)
// 用法:
//   const mind = new MindClient({ agentSource: 'HERMES_AGENT', endpoint: 'http://localhost:3000' });
//   await mind.init();
//   const sections = await mind.getSystemPromptSections();
//   const hits = await mind.recall('dashboard', { depth: 'hot' });
//   const { id, deduplicated } = await mind.remember({ content: '...', tier: 'WARM' });
//   await mind.flush();

import { createHash } from "crypto";
import { promises as fs } from "fs";
import { existsSync, mkdirSync } from "fs";
import * as path from "path";
import * as os from "os";

// ============ Types ============

export type Tier = "HOT" | "WARM" | "COLD";
export type Depth = "hot" | "warm" | "cold";
export type AgentSource =
  | "HERMES_AGENT"
  | "CLAUDE_AGENT"
  | "MORNING_AGENT"
  | "THIRTEEN_AGENT"
  | "SDK_UNKNOWN";

export interface MindClientConfig {
  agentSource: AgentSource;
  endpoint?: string;        // 默认 http://localhost:3000
  cacheDir?: string;        // 默认 ~/.cache/mind
  timeoutMs?: number;       // 默认 5000
  maxRetries?: number;      // 默认 2
  degraded?: boolean;       // 强制降级 (跳过 API, 只用本地 cache)
  // P3-15 改造: 2026-06-17 register 后存 apiKey, 业务端点用 x-api-key 鉴权
  apiKey?: string;          // register 端点返的明文 apiKey, 24h 过期
  bootstrapKey?: string;    // register 端点准入 (MIND_BOOTSTRAP_API_KEY)
}

export interface MemoryItem {
  id: string;
  content: string;
  title: string | null;
  tier: string;
  type: string | null;
  domain: string | null;
  tags: string | null;
  importance: number;
  valueScore: number;
  agentSource: string | null;
  createdAt: number | string;
  accessCount: number;
  deduplicated?: boolean;
}

export interface RecallHit {
  id: string;
  content: string;
  title: string | null;
  tier: string;
  importance: number;
  source: 'cache' | 'api';
}

export interface RememberResult {
  id: string;
  deduplicated: boolean;
}

export interface SystemPromptSections {
  hotMemories: string;
  userPreferences: string;
  raw: { hot: MemoryItem[]; total: number };
}

// ============ LRU Cache (简单实现) ============

class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private maxSize: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // 移到尾部
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
  }
  has(key: K): boolean { return this.map.has(key); }
  size(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
}

// ============ MindClient ============

export class MindClient {
  private config: Required<MindClientConfig>;
  private recallCache: LRUCache<string, RecallHit[]>;
  private hotCache: { items: MemoryItem[]; ts: number } | null = null;
  private writeQueue: Array<{ content: string; tier: Tier; type?: string; domain?: string; tags?: string; importance?: number; ts: number }> = [];
  private initialized = false;
  private healthy = true;
  private _autoBootstrapped = false;  // M3: auto-bootstrap 一次性, 防递归

  constructor(config: MindClientConfig) {
    this.config = {
      agentSource: config.agentSource,
      endpoint: (config.endpoint || "http://localhost:3000").replace(/\/+$/, ""),
      cacheDir: config.cacheDir || path.join(os.homedir(), ".cache", "mind"),
      timeoutMs: config.timeoutMs ?? 5000,
      maxRetries: config.maxRetries ?? 2,
      degraded: config.degraded ?? false,
      // P3-15 改造: apiKey / bootstrapKey 可选 (没 register 也能用 publicProcedure 端点)
      apiKey: config.apiKey ?? "",
      bootstrapKey: config.bootstrapKey ?? "",
    };
    this.recallCache = new LRUCache(200);
    // 启动时确保 cache 目录在
    try { mkdirSync(this.config.cacheDir, { recursive: true }); } catch {}
  }

  // ----- init: 端点连通性测试 -----
  async init(): Promise<{ healthy: boolean; endpoint: string }> {
    try {
      const url = `${this.config.endpoint}/api/trpc/memory.getTierDistribution`;
      const res = await this.fetchWithTimeout(url, { method: "GET" });
      if (res.ok) {
        this.healthy = true;
        this.initialized = true;
      } else {
        this.healthy = false;
      }
    } catch (e) {
      this.healthy = false;
    }
    if (!this.healthy) {
      // 尝试从 disk 加载 hot cache 作为兜底
      await this.loadHotCacheFromDisk();
    }
    return { healthy: this.healthy, endpoint: this.config.endpoint };
  }

  // ----- register: agent 服务注册 (P3-15 新增 2026-06-17)
  //   1. 用 bootstrapKey 调 register 端点
  //   2. 拿 services 各 apiKey (明文一次性)
  //   3. 自动存到 ~/.config/agent-{agentId}/{serviceName}.env
  //   4. 返 register response
  async register(input: {
    agentId: string;
    displayName: string;
    channel: "hermes" | "claude" | "mcp" | "custom";
    host: string;
    services?: Array<{ name: string; permissions?: string[]; config?: Record<string, any> }>;
    profile?: Record<string, any>;
    avatar?: string;
    sdkVersion?: string;
  }): Promise<{
    status: "ok" | "partial";
    agent_id: string;
    services: Record<string, {
      status: string;
      api_key?: string;
      endpoint?: string;
      permissions?: string[];
      token_id?: string;
      expires_at?: string;
    }>;
    // 2026-10-15 钥匙治理(item 1): register **不再直发业务钥匙** —— 只发一张一次性领取券
    //   (`sk-claim-…`, 默认 15 分钟、绑定 agent_id、只能用一次), 用 `claimServiceKeys()` 换取正式钥匙。
    claim_ticket?: {
      value: string;
      hash8: string;
      expires_at: string;
      ttl_seconds: number;
      services: string[];
    };
    claim_required_services?: string[];
    business_key_ttl_days?: number;
  }> {
    if (!this.config.bootstrapKey) {
      throw new Error("bootstrapKey required for register (set in MindClientConfig)");
    }
    const url = `${this.config.endpoint}/api/trpc/agent.register`;
    const res = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bootstrap-key": this.config.bootstrapKey,
      },
      body: JSON.stringify({
        agent_id: input.agentId,
        display_name: input.displayName,
        channel: input.channel,
        host: input.host,
        sdk_version: input.sdkVersion || "1.0.0",
        services: input.services,
        profile: input.profile,
        avatar: input.avatar,
      }),
    });
    if (!res.ok) {
      throw new Error(`register failed: HTTP ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    const data = json.result?.data || json.result || json;

    // 评审 P0-2 [SDK 路径分流]: 路径分流用 'input.services 是否在 request payload' 判断, 不依赖 sdk_version 字符串
    // 这里的 input 来自调用方传的 services, 传 = 走新路径, 没传 = 老路径 (服务端已兼容)
    const isNewPath = input.services !== undefined;
    (data as any)._path = isNewPath ? "v1_services_array" : "v0_legacy_default_all";

    // 评审 P0-1 [同步性]: 收到 status=partial → 失败 service 启动自动重试 (3次, 指数退避 1s/2s/4s)
    if (data.status === "partial" && data.services) {
      const failedServices = Object.entries(data.services)
        .filter(([_, c]: [string, any]) => c.status !== "registered" && c.status !== "repaired")
        .map(([name]) => name);
      if (failedServices.length > 0) {
        console.warn(`[register] partial: ${failedServices.join(", ")} 失败, 启动自动重试 (3次)`);
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));  // 1s/2s/4s 退避
          try {
            // 单独重试失败 service (调用同一个 register 端点, 只传失败 service)
            const repairRes = await this.fetchWithTimeout(`${this.config.endpoint}/api/trpc/agent.register`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-bootstrap-key": this.config.bootstrapKey,
              },
              body: JSON.stringify({
                agent_id: input.agentId,
                display_name: input.displayName,
                channel: input.channel,
                host: input.host,
                sdk_version: input.sdkVersion || "1.0.0",
                services: failedServices.map((n) => ({ name: n })),  // 只传失败 service
                profile: input.profile,
                avatar: input.avatar,
              }),
            });
            if (repairRes.ok) {
              const repairJson = await repairRes.json();
              const repairData = repairJson.result?.data || repairJson.result || repairJson;
              // 合并成功结果
              if (repairData.services) {
                for (const [name, creds] of Object.entries(repairData.services)) {
                  if ((creds as any).status === "registered" && (creds as any).api_key) {
                    data.services[name] = creds;
                    // 从 failedServices 移除
                    const idx = failedServices.indexOf(name);
                    if (idx >= 0) failedServices.splice(idx, 1);
                  }
                }
              }
              if (failedServices.length === 0) break;  // 全成功
            }
          } catch (e) {
            // 继续下一次重试
          }
        }
        // 重试仍失败的 service 标 .failed 标记
        if (failedServices.length > 0) {
          const home = os.homedir();
          const dir = path.join(home, ".config", `agent-${input.agentId}`);
          for (const name of failedServices) {
            const fp = path.join(dir, `${name}.failed`);
            try { await fs.writeFile(fp, JSON.stringify({ service: name, failed_at: new Date().toISOString(), reason: "register partial + 3 retries failed" }, null, 2), { mode: 0o600 }); } catch {}
          }
          console.warn(`[register] 重试 3 次仍失败: ${failedServices.join(", ")} 标 .failed`);
        }
        // 跟新合并后的 status
        data.status = failedServices.length === 0 ? "ok" : "partial";
      }
    }

    // 帮 agent 落盘各服务凭证到 ~/.config/agent-{id}/{serviceName}.env
    // 评审 P1-3: 凭证落盘 mode 0600 (仅 owner 可读写)
    // Node.js 坑: writeFile mode 只在文件不存在时生效, 已存在的文件要 chmod
    const home = os.homedir();
    const dir = path.join(home, ".config", `agent-${input.agentId}`);
    try { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); } catch {}
    for (const [name, creds] of Object.entries(data.services || {})) {
      if ((creds as any).api_key) {
        const fp = path.join(dir, `${name}.env`);
        const content = `API_KEY=${(creds as any).api_key}\nENDPOINT=${(creds as any).endpoint}\nEXPIRES_AT=${(creds as any).expires_at}\n`;
        try {
          await fs.writeFile(fp, content);
          await fs.chmod(fp, 0o600);  // 确保 mode 0600 (覆盖已存在文件)
        } catch (e) { /* ignore */ }
      }
    }
    // 如果这次是 lions_mind 服务, 自动把 apiKey 设到 config
    if (data.services?.lions_mind?.api_key) {
      this.config.apiKey = data.services.lions_mind.api_key;
    }
    return data;
  }

  /**
   * claimServiceKeys — 用一次性领取券换正式业务钥匙 (2026-10-15 钥匙治理 item 1)
   *
   * 为什么需要它: 平台注册/审批不再直发长期业务钥匙, 只发一张 `sk-claim-…` 领取券(默认 15 分钟、
   *   绑定 agent_id、只能用一次)。本方法把它换成该 agent 的**全部**业务钥匙(默认 90 天), 并按与
   *   `register()` 相同的落盘约定写到 `~/.config/agent-<id>/<service>.env`(mode 0600)。
   * 注意: 券换完立即作废(再调会 403); 换到的明文只出现一次 —— 请立即落盘, 不要只放在内存里。
   */
  async claimServiceKeys(input: { agentId: string; ticket: string; reuseExisting?: boolean }): Promise<Record<string, any>> {
    const url = `${this.config.endpoint}/api/v1/agent/claim-service-key`;
    const res = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: input.agentId,
        ticket: input.ticket,
        reuse_existing: input.reuseExisting !== false,
      }),
    });
    if (!res.ok) {
      throw new Error(`claimServiceKeys failed: HTTP ${res.status} ${await res.text()}`);
    }
    const json: any = await res.json();
    if (!json?.ok) throw new Error(`claimServiceKeys failed: ${json?.error || "unknown"}`);
    const services = json.services || {};
    // 与 register() 同款落盘(0600) + 把 lions_mind key 写进 config
    const dir = path.join(os.homedir(), ".config", `agent-${input.agentId}`);
    try { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); } catch {}
    for (const [name, creds] of Object.entries(services)) {
      const c = creds as any;
      if (!c?.api_key) continue;
      const fp = path.join(dir, `${name}.env`);
      try {
        await fs.writeFile(fp, `API_KEY=${c.api_key}\nENDPOINT=${c.endpoint}\nEXPIRES_AT=${c.expires_at}\n`);
        await fs.chmod(fp, 0o600);
      } catch { /* ignore */ }
    }
    if (services.lions_mind?.api_key) this.config.apiKey = services.lions_mind.api_key;
    return json;
  }

  // ----- getSystemPromptSections: 拼 system prompt 段落 -----
  async getSystemPromptSections(limit = 20, tokenBudget = 3000): Promise<SystemPromptSections> {
    let items: MemoryItem[] = [];
    if (this.hotCache && Date.now() - this.hotCache.ts < 5 * 60 * 1000) {
      items = this.hotCache.items;
    } else {
      try {
        const url = `${this.config.endpoint}/api/trpc/memory.list?input=${encodeURIComponent(
          JSON.stringify({ json: { tier: "HOT", page: 1, pageSize: limit } })
        )}`;
        const res = await this.fetchWithTimeout(url);
        if (res.ok) {
        const json = await res.json();
        items = this.parseTrpcItems(json);
          this.hotCache = { items, ts: Date.now() };
          // 落盘兜底
          await this.saveHotCacheToDisk(items);
        }
      } catch (e) {
        // 失败, 用 disk cache 兜底
        items = (await this.loadHotCacheFromDisk()) || [];
      }
    }

    // 按 importance desc, 限 token
    const sorted = [...items].sort((a, b) => (b.importance || 0) - (a.importance || 0));
    const picked: MemoryItem[] = [];
    let usedTokens = 0;
    for (const m of sorted) {
      const text = m.title || m.content.slice(0, 80);
      const estTokens = Math.ceil(text.length / 4); // 粗估 4 字符/token
      if (usedTokens + estTokens > tokenBudget) break;
      picked.push(m);
      usedTokens += estTokens;
    }

    const lines = picked.map((m) =>
      `- [${m.tier}/${m.type || "?"}] ${m.title || m.content.slice(0, 80).replace(/\n/g, " ")} (src: ${m.agentSource || "?"}, imp: ${m.importance?.toFixed(2) || "?"})`
    );
    const hotMemories = `## 共享记忆 (from Lions-Mind, ${picked.length} 条 HOT)\n${lines.join("\n")}`;

    const userPreferences = `## 用户偏好 (运营者)\n- 中文交流, 简洁直接, 不喜欢冗长解释\n- 回答先给结论 + 行动项, 再讲原因\n- "修好"必须用 vision 截图实测, 不能用 curl 200 自欺欺人\n- 破坏性操作前先备份\n- 多用列表 + 表格, 少用大段文字`;

    return { hotMemories, userPreferences, raw: { hot: picked, total: items.length } };
  }

  // 解析 trpc response (支持 v10/v11/batch)
  private parseTrpcItems(json: any): MemoryItem[] {
    if (!json) return [];
    let data: any = json.result?.data;
    if (data && data.json !== undefined) data = data.json; // v11
    if (data && data.items !== undefined) return data.items;
    // batch format
    if (Array.isArray(json) && json[0]?.result?.data) {
      const d = json[0].result.data;
      return d.json?.items || d.items || [];
    }
    return [];
  }

  // 解析 trpc response 单个 object (用于 memory.create 返的)
  private parseTrpcObject(json: any): any {
    if (!json) return null;
    let data: any = json.result?.data;
    if (data && data.json !== undefined) data = data.json;
    if (Array.isArray(json) && json[0]?.result?.data) {
      const d = json[0].result.data;
      return d.json || d;
    }
    return data;
  }

  // ----- recall: 查记忆 -----
  async recall(query: string, options: { depth?: Depth; limit?: number; minImportance?: number } = {}): Promise<RecallHit[]> {
    const depth = options.depth || "hot";
    const limit = options.limit || 5;
    const cacheKey = `${depth}:${limit}:${query}`;
    if (this.recallCache.has(cacheKey)) {
      // 标记 cache 来源
      const cached = this.recallCache.get(cacheKey)!;
      return cached.map((h) => ({ ...h, source: 'cache' as const }));
    }

    // P1-7: in-flight dedup — 并发同 query 只发一个请求
    if (this.inFlightRecall.has(cacheKey)) {
      return (await this.inFlightRecall.get(cacheKey)!) as RecallHit[];
    }

    const promise = this._doRecall(cacheKey, depth, limit, query, options);
    this.inFlightRecall.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlightRecall.delete(cacheKey);
    }
  }

  private async _doRecall(cacheKey: string, depth: Depth, limit: number, query: string, options: { minImportance?: number }): Promise<RecallHit[]> {

    let hits: RecallHit[] = [];
    if (this.healthy && !this.config.degraded) {
      try {
        // 根据 depth 选 tier
        const tier = depth === "hot" ? "HOT" : depth === "warm" ? "WARM" : "COLD";
        const url = `${this.config.endpoint}/api/trpc/memory.list?input=${encodeURIComponent(
          JSON.stringify({ json: { tier, search: query.slice(0, 50), page: 1, pageSize: limit } })
        )}`;
        const res = await this.fetchWithTimeout(url);
        if (res.ok) {
        const json = await res.json();
        const items: MemoryItem[] = this.parseTrpcItems(json);
          hits = items
            .filter((m) => (m.importance || 0) >= (options.minImportance || 0))
            .map((m) => ({
              id: m.id, content: m.content, title: m.title,
              tier: m.tier, importance: m.importance || 0, source: 'api' as const,
            }));
        }
      } catch (e) {
        // API 失败, 用 hotCache 兜底
        if (this.hotCache) {
          hits = this.hotCache.items
            .filter((m) => m.content.includes(query) || (m.title || "").includes(query))
            .slice(0, limit)
            .map((m) => ({ id: m.id, content: m.content, title: m.title, tier: m.tier, importance: m.importance || 0, source: 'cache' as const }));
        }
      }
    } else if (this.hotCache) {
      // degraded mode
      hits = this.hotCache.items
        .filter((m) => m.content.includes(query) || (m.title || "").includes(query))
        .slice(0, limit)
        .map((m) => ({ id: m.id, content: m.content, title: m.title, tier: m.tier, importance: m.importance || 0, source: 'cache' as const }));
    }

    this.recallCache.set(cacheKey, hits);
    return hits;
  }

  // ----- remember: 写记忆 (含 24h 业务去重) -----
  // P3-15 改造: per-write agentSource 可选, 覆盖构造时设的 this.config.agentSource
  async remember(input: {
    content: string;
    tier?: Tier;
    type?: string;
    domain?: string;
    tags?: string;
    importance?: number;
    agentSource?: AgentSource;  // 覆盖默认 agentSource (单条 per-write 切源)
  }): Promise<RememberResult> {
    return this.withWriteLock(async () => {
    const tier = input.tier || "WARM";
    const payload = {
      content: input.content,
      tier,
      type: input.type,
      domain: input.domain,
      tags: input.tags,
      importance: input.importance,
      agentSource: input.agentSource || this.config.agentSource,
    };

    if (!this.healthy || this.config.degraded) {
      // 降级: 进本地队列
      this.writeQueue.push({ ...input, tier, ts: Date.now() });
      await this.saveQueueToDisk();
      return { id: "queued-" + Date.now(), deduplicated: false };
    }

    try {
      const url = `${this.config.endpoint}/api/trpc/memory.create`;
      // P1-7: 用 fetchWithRetry 替代 fetchWithTimeout (5xx 指数退避重试 2 次)
      const res = await this.fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, 2);
      if (!res.ok) {
        // 4xx 校验错, 不重试; 5xx 进队列
        if (res.status >= 500) {
          this.writeQueue.push({ ...input, tier, ts: Date.now() });
          await this.saveQueueToDisk();
        }
        return { id: "error-" + res.status, deduplicated: false };
      }
      const json = await res.json();
      const m = this.parseTrpcObject(json) || {};
      return { id: m.id, deduplicated: !!m.deduplicated };
    } catch (e) {
      // 网络错 (重试 2 次后仍失败), 进队列
      this.writeQueue.push({ ...input, tier, ts: Date.now() });
      await this.saveQueueToDisk();
      return { id: "queued-" + Date.now(), deduplicated: false };
    }
    });
  }

  // ----- flush: 把队列里的写入冲刷出去 -----
  async flush(): Promise<{ flushed: number; failed: number }> {
    if (this.writeQueue.length === 0) return { flushed: 0, failed: 0 };
    const items = [...this.writeQueue];
    this.writeQueue = [];
    let flushed = 0, failed = 0;
    for (const item of items) {
      try {
        const r = await this.remember(item);
        if (r.id.startsWith("queued-") || r.id.startsWith("error-")) {
          this.writeQueue.push(item);
          failed++;
        } else {
          flushed++;
        }
      } catch {
        this.writeQueue.push(item);
        failed++;
      }
    }
    await this.saveQueueToDisk();
    return { flushed, failed };
  }

  // ----- 内部: fetch + timeout + 重试 + metrics -----
  // P3-15 改造: 业务端点 protectedProcedure 需 x-api-key 鉴权
  // M3 (2026-06-17): 加 auto-bootstrap 模式 — 业务端点 401 时自动 register 拿 apiKey 重试
  private async fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const start = Date.now();
    try {
      // 自动注入 x-api-key (业务端点用, register 端点用 x-bootstrap-key 单独)
      const headers = new Headers(init.headers);
      const isRegister = url.endsWith("/agent.register");
      if (this.config.apiKey && !headers.has("x-api-key") && !isRegister) {
        headers.set("x-api-key", this.config.apiKey);
      }
      const res = await fetch(url, { ...init, signal: controller.signal, headers });
      // M3: 业务端点 401 + 有 bootstrapKey + 没 apiKey → 自动 register 拿 apiKey + 重试一次
      if (
        res.status === 401 &&
        !isRegister &&
        !this.config.apiKey &&
        this.config.bootstrapKey &&
        !this._autoBootstrapped &&
        !headers.has("x-api-key")
      ) {
        this._autoBootstrapped = true;
        try {
          await this.register({
            agentId: this.config.agentSource.toLowerCase().replace(/_/g, "-"),
            displayName: this.config.agentSource,
            channel: "custom",
            host: "auto-bootstrap",
            sdkVersion: "1.6.0-auto",
          });
          // register 成功后 apiKey 已设, 重试
          const retryHeaders = new Headers(init.headers);
          if (this.config.apiKey) retryHeaders.set("x-api-key", this.config.apiKey);
          const retryRes = await fetch(url, { ...init, signal: controller.signal, headers: retryHeaders });
          const ms = Date.now() - start;
          this.recordMetric("http", url.includes("memory.create") ? "memory.create" : url.split("/").pop() || "unknown", retryRes.status, ms);
          return retryRes;
        } catch (e) {
          // auto-bootstrap 失败, 返原 401
        }
      }
      const ms = Date.now() - start;
      this.recordMetric("http", url.includes("memory.create") ? "memory.create" : url.split("/").pop() || "unknown", res.status, ms);
      return res;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ----- 重试 fetch (5xx + 网络错 指数退避) -----
  private async fetchWithRetry(url: string, init: RequestInit = {}, retries = 2): Promise<Response> {
    let lastErr: any = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.fetchWithTimeout(url, init);
        if (res.ok || (res.status >= 400 && res.status < 500)) {
          // OK or 4xx (client error, no retry)
          return res;
        }
        // 5xx: retry
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
      if (attempt < retries) {
        const backoff = Math.min(1000 * 2 ** attempt, 5000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr ?? new Error("fetch failed after retries");
  }

  // ----- 内部: hot cache 落盘 -----
  private async saveHotCacheToDisk(items: MemoryItem[]) {
    const fp = path.join(this.config.cacheDir, `hot-${new Date().toISOString().slice(0, 10)}.json`);
    try { await fs.writeFile(fp, JSON.stringify({ items, ts: Date.now() }, null, 2)); } catch {}
  }
  private async loadHotCacheFromDisk(): Promise<MemoryItem[] | null> {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const fp = path.join(this.config.cacheDir, `hot-${today}.json`);
      if (!existsSync(fp)) {
        // 找最近的一个
        const files = await fs.readdir(this.config.cacheDir);
        const candidates = files.filter((f) => f.startsWith("hot-")).sort().reverse();
        if (candidates.length === 0) return null;
        const data = await fs.readFile(path.join(this.config.cacheDir, candidates[0]), "utf-8");
        const obj = JSON.parse(data);
        this.hotCache = { items: obj.items || [], ts: obj.ts || 0 };
        return obj.items || [];
      }
      const data = await fs.readFile(fp, "utf-8");
      const obj = JSON.parse(data);
      this.hotCache = { items: obj.items || [], ts: obj.ts || 0 };
      return obj.items || [];
    } catch { return null; }
  }

  // ----- 内部: 写队列落盘 -----
  private async saveQueueToDisk() {
    const today = new Date().toISOString().slice(0, 10);
    const fp = path.join(this.config.cacheDir, `queue-${today}.ndjson`);
    try {
      const content = this.writeQueue.map((q) => JSON.stringify(q)).join("\n") + "\n";
      await fs.writeFile(fp, content);
    } catch {}
  }

  // ----- 并发安全: in-flight 锁 + 单写锁 (P1-7) -----
  private inFlightRecall = new Map<string, Promise<any[]>>();
  private writeLock: Promise<void> = Promise.resolve();

  // 用 mutex 包裹 (避免并发写)
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((r) => (release = r));
    try {
      await prev;
      return await fn();
    } finally {
      release!();
    }
  }

  // ----- 公共状态查询 -----
  isHealthy(): boolean { return this.healthy; }
  isDegraded(): boolean { return this.config.degraded || !this.healthy; }
  queueSize(): number { return this.writeQueue.length; }
  recallCacheSize(): number { return this.recallCache.size(); }

  // ----- Metrics (P1-7) -----
  private metrics: Array<{ type: string; endpoint: string; status: number; ms: number; ts: number }> = [];
  private recordMetric(type: string, endpoint: string, status: number, ms: number): void {
    this.metrics.push({ type, endpoint, status, ms, ts: Date.now() });
    // 只保留最近 100 条
    if (this.metrics.length > 100) this.metrics = this.metrics.slice(-100);
  }

  getMetrics(): { type: string; endpoint: string; status: number; ms: number; ts: number }[] {
    return [...this.metrics];
  }

  // 按 endpoint 聚合
  getMetricsSummary(): Record<string, { count: number; avgMs: number; errorCount: number }> {
    const byEp: Record<string, { count: number; totalMs: number; errorCount: number }> = {};
    for (const m of this.metrics) {
      if (!byEp[m.endpoint]) byEp[m.endpoint] = { count: 0, totalMs: 0, errorCount: 0 };
      byEp[m.endpoint].count++;
      byEp[m.endpoint].totalMs += m.ms;
      if (m.status >= 400) byEp[m.endpoint].errorCount++;
    }
    const summary: Record<string, { count: number; avgMs: number; errorCount: number }> = {};
    for (const [k, v] of Object.entries(byEp)) {
      summary[k] = {
        count: v.count,
        avgMs: Math.round(v.totalMs / v.count),
        errorCount: v.errorCount,
      };
    }
    return summary;
  }

  resetMetrics(): void { this.metrics = []; }
}
