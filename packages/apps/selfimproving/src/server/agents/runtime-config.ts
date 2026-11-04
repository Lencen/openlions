/**
 * 运行时配置(磁盘持久化版)
 *
 * 存储:data/system-config.json(进程外持久,重启保留)
 * 字段:
 *   taskBatchOverride: number | null — 任务端固定 batchSize(null=不覆盖,走公式)
 *   problemBatchOverride: number | null — 问题端固定 batchSize
 *   taskSmartMode: boolean — 任务端智能模式(true=按队列公式自动调整,忽略 override)
 *   problemSmartMode: boolean — 问题端智能模式(暂未实现,只读 taskSmartMode)
 */

import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "data", "system-config.json");

export const defaultTaskBatch = 10;
export const defaultProblemBatch = 50;

interface SystemConfig {
  taskBatchOverride: number | null;
  problemBatchOverride: number | null;
  taskSmartMode: boolean;
  problemSmartMode: boolean;
  updatedAt: string;
  updatedBy?: string;
}

const defaultConfig: SystemConfig = {
  taskBatchOverride: null,
  problemBatchOverride: null,
  taskSmartMode: true,  // 默认开智能
  problemSmartMode: true,
  updatedAt: new Date().toISOString(),
};

// 内存缓存(避免每次读盘)
let cache: SystemConfig | null = null;

function readConfig(): SystemConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Partial<SystemConfig>;
      return { ...defaultConfig, ...parsed };
    }
  } catch (e) {
    console.error("[runtime-config] 读配置失败,使用默认:", e);
  }
  return { ...defaultConfig };
}

function writeConfig(cfg: SystemConfig) {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
    cache = cfg;
  } catch (e) {
    console.error("[runtime-config] 写配置失败:", e);
    throw e;
  }
}

function getCached(): SystemConfig {
  if (!cache) cache = readConfig();
  return cache;
}

// ===== 任务端 =====
export function getTaskSmartMode(): boolean {
  return getCached().taskSmartMode;
}

export function getTaskBatchSize(): number {
  const cfg = getCached();
  // 智能模式:返回 defaultTaskBatch(由 scheduler 决定用公式还是默认)
  // 固定模式:返回 override 或 default
  if (cfg.taskSmartMode) return defaultTaskBatch;  // 信号:由 scheduler 走公式
  if (cfg.taskBatchOverride !== null && cfg.taskBatchOverride > 0) return cfg.taskBatchOverride;
  return defaultTaskBatch;
}

export function setTaskBatch(value: number | null, smartMode: boolean, updatedBy?: string) {
  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 200)) {
    throw new Error("task batchSize 必须是 1-200 整数(或 null 恢复默认)");
  }
  const cfg = getCached();
  cfg.taskBatchOverride = value;
  cfg.taskSmartMode = smartMode;
  cfg.updatedAt = new Date().toISOString();
  if (updatedBy) cfg.updatedBy = updatedBy;
  writeConfig(cfg);
}

// ===== 问题端 =====
export function getProblemSmartMode(): boolean {
  return getCached().problemSmartMode;
}

export function getProblemBatchSize(): number {
  const cfg = getCached();
  if (cfg.problemSmartMode) return defaultProblemBatch;
  if (cfg.problemBatchOverride !== null && cfg.problemBatchOverride > 0) return cfg.problemBatchOverride;
  return defaultProblemBatch;
}

export function setProblemBatch(value: number | null, smartMode: boolean, updatedBy?: string) {
  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 200)) {
    throw new Error("problem batchSize 必须是 1-200 整数(或 null 恢复默认)");
  }
  const cfg = getCached();
  cfg.problemBatchOverride = value;
  cfg.problemSmartMode = smartMode;
  cfg.updatedAt = new Date().toISOString();
  if (updatedBy) cfg.updatedBy = updatedBy;
  writeConfig(cfg);
}

// ===== 全量接口 =====
export function getRuntimeConfig() {
  const cfg = getCached();
  return {
    taskBatchSize: getTaskBatchSize(),
    taskBatchDefault: defaultTaskBatch,
    taskBatchOverride: cfg.taskBatchOverride,
    taskSmartMode: cfg.taskSmartMode,
    problemBatchSize: getProblemBatchSize(),
    problemBatchDefault: defaultProblemBatch,
    problemBatchOverride: cfg.problemBatchOverride,
    problemSmartMode: cfg.problemSmartMode,
    updatedAt: cfg.updatedAt,
  };
}
