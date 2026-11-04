/**
 * LionsSessionAdapter — V1 §15.2.1 阶段交付
 *
 * mind 侧 HTTP client, 走 lions-session 服务的 /api/v1/* 端点
 * 让 mind 不再本地存 SessionRegistry 原文, 只存 sessionUid + 处理状态
 *
 * 数据流:
 *   1. scan()            → GET /api/v1/sessions?since=&status=PENDING&limit=100
 *   2. fetchDetail(uid)  → GET /api/v1/sessions/:uid (拉原文给 LLM)
 *   3. markStatus(uid,…) → PATCH /api/v1/sessions/:uid/status
 *
 * 设计原则:
 *   - stdlib-only (urllib), 符合 §21.10 SDK 改 stdlib-first
 *   - 强制 X-API-Key 鉴权
 *   - 重试: 5xx 自动重试 3 次, 4xx 直接抛 (不重试)
 *   - cursor/watermark 都从服务端拿, 本地不猜时间
 */

import { sessionApiKey } from "@/lib/secret";
import * as http from "http";
import * as https from "https";
import { URL } from "url";

export interface SessionSummary {
  sessionUid: string;
  agentId: string | null;
  source: string | null;
  title: string | null;
  startedAt: string | null;
  updatedAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  status: string;
}

export interface MessageDetail {
  messageUid: string;
  role: string;
  content: string | null;
  createdAt: string;
  model: string | null;
  reasoning: string | null;
}

export interface SessionDetail {
  session: {
    sessionUid: string;
    agentId: string | null;
    source: string | null;
    sourceId: string | null;
    title: string | null;
    startedAt: string | null;
    lastMessageAt: string | null;
    updatedAt: string;
    messageCount: number;
    status: string;
    model: string | null;
    platform: string | null;
  };
  messages: MessageDetail[];
}

export interface ListResult {
  items: SessionSummary[];
  nextCursor: string | null;
  watermark: string;
}

export interface ListOptions {
  since?: string;
  status?: string;
  agentId?: string;
  source?: string;
  cursor?: string;
  limit?: number;
  minMessages?: number;
}

export class LionsSessionAdapter {
  private baseUrl: string;
  private apiKey: string;
  private maxRetries: number;

  constructor(opts?: { baseUrl?: string; apiKey?: string; maxRetries?: number }) {
    this.baseUrl =
      opts?.baseUrl ||
      process.env.LIONS_SESSION_URL ||
      "http://localhost:3002";
    this.apiKey =
      opts?.apiKey ||
      sessionApiKey(/* LIONS_SESSION_API_KEY */);
    this.maxRetries = opts?.maxRetries ?? 3;
  }

  /** V1 §15.2.1: GET /api/v1/sessions */
  async scan(options: ListOptions = {}): Promise<ListResult> {
    const qs = new URLSearchParams();
    if (options.since) qs.set("since", options.since);
    if (options.status) qs.set("status", options.status);
    if (options.agentId) qs.set("agentId", options.agentId);
    if (options.source) qs.set("source", options.source);
    if (options.cursor) qs.set("cursor", options.cursor);
    if (options.limit) qs.set("limit", String(options.limit));
    if (options.minMessages) qs.set("minMessages", String(options.minMessages));

    const path = `/api/v1/sessions${qs.toString() ? "?" + qs : ""}`;
    return this.request<ListResult>("GET", path);
  }

  /** V1 §15.2.1: GET /api/v1/sessions/:uid */
  async fetchDetail(sessionUid: string): Promise<SessionDetail> {
    return this.request<SessionDetail>(
      "GET",
      `/api/v1/sessions/${encodeURIComponent(sessionUid)}`
    );
  }

  /** V1 §15.2.1: PATCH /api/v1/sessions/:uid/status
   * B14 修复 (2026-07-01): 409 视为幂等成功 —
   * lions-session 状态机拒绝非法转换 (DONE→PROCESSING / FAILED→DONE) 时,
   * 说明服务端已经处于终态 (DONE/FAILED), 客户端无需重试也不应报错。
   */
  async markStatus(
    sessionUid: string,
    status: "PROCESSING" | "DONE" | "FAILED",
    opts: { processedBy?: string; error?: string } = {}
  ): Promise<{ sessionUid: string; status: string; processedAt: string; version: number; skipped?: boolean }> {
    try {
      return await this.request("PATCH", `/api/v1/sessions/${encodeURIComponent(sessionUid)}/status`, {
        status,
        processedBy: opts.processedBy || "mind-pull",
        error: opts.error,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 409 状态机拒绝: 服务端已在终态, 幂等 skip
      if (msg.includes("→ 409:") || msg.includes("不允许")) {
        return { sessionUid, status, processedAt: new Date().toISOString(), version: -1, skipped: true };
      }
      throw e;
    }
  }

  /** 拉所有 PENDING session, 自动分页, 返回完整列表 */
  async scanAllPending(
    opts: { since?: string; agentId?: string; limit?: number } = {}
  ): Promise<SessionSummary[]> {
    const all: SessionSummary[] = [];
    let cursor: string | null = null;
    const pageSize = opts.limit || 100;

    do {
      const result = await this.scan({
        since: opts.since,
        status: "PENDING",
        agentId: opts.agentId,
        cursor: cursor || undefined,
        limit: pageSize,
      });
      all.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);

    return all;
  }

  // ─── stdlib HTTP ───────────────────────────────────────────

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const data = body ? JSON.stringify(body) : undefined;
      const lib = url.protocol === "https:" ? https : http;

      const headers: Record<string, string> = {
        "X-API-Key": this.apiKey,
        Accept: "application/json",
      };
      if (data) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(Buffer.byteLength(data));
      }

      const attempt = (tryNo: number) => {
        console.error(`[adapter-dbg] ${method} ${path} try=${tryNo}`);
        const req = lib.request(
          {
            method,
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname + url.search,
            headers,
            timeout: 60000,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const status = res.statusCode || 0;
              const text = Buffer.concat(chunks).toString("utf8");

              if (status >= 200 && status < 300) {
                try {
                  resolve(text ? JSON.parse(text) : ({} as T));
                } catch (e) {
                  // JSON 坏了 (可能 res 被中断) → 落盘调试 + 重试
                  try {
                    const fs = require("fs");
                    fs.writeFileSync(
                      `/tmp/adapter-bad-${Date.now()}-t${tryNo}.raw`,
                      text
                    );
                  } catch {}
                  if (tryNo < this.maxRetries) {
                    const delay = 500 * Math.pow(2, tryNo - 1);
                    setTimeout(() => attempt(tryNo + 1), delay);
                  } else {
                    reject(new Error(`Invalid JSON from ${path} after ${tryNo} tries (${text.length}B): ${e}`));
                  }
                }
                return;
              }

              // 5xx 重试, 4xx 直接抛
              if (status >= 500 && tryNo < this.maxRetries) {
                const delay = 500 * Math.pow(2, tryNo - 1);
                setTimeout(() => attempt(tryNo + 1), delay);
                return;
              }

              let detail: any = text;
              try {
                detail = JSON.parse(text);
              } catch {
                /* keep text */
              }
              reject(
                new Error(
                  `LionsSessionAdapter ${method} ${path} → ${status}: ${
                    typeof detail === "string" ? detail : detail?.error || ""
                  }`
                )
              );
            });
          }
        );

        req.on("error", (e) => {
          if (tryNo < this.maxRetries) {
            const delay = 500 * Math.pow(2, tryNo - 1);
            setTimeout(() => attempt(tryNo + 1), delay);
          } else {
            reject(e);
          }
        });
        req.on("timeout", () => req.destroy(new Error(`timeout 15s ${path}`)));

        if (data) req.write(data);
        req.end();
      };

      attempt(1);
    });
  }
}