/**
 * 安全增强系统
 * - 隐私过滤
 * - 输入验证
 * - 速率限制
 * - 操作日志
 */

import { personalityStore } from "./personality";

export interface SecurityConfig {
  enablePrivacyFilter: boolean;
  enableInputValidation: boolean;
  enableRateLimiting: boolean;
  maxRequestsPerMinute: number;
  sensitivePatterns: (string | RegExp)[];
}

export interface LogEntry {
  id: string;
  level: "info" | "warn" | "error" | "debug";
  category: "tool" | "api" | "user" | "system";
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: string;
}

const DEFAULT_CONFIG: SecurityConfig = {
  enablePrivacyFilter: true,
  enableInputValidation: true,
  enableRateLimiting: true,
  maxRequestsPerMinute: 30,
  sensitivePatterns: [
    /(?:password|passwd|pwd)[\s:=]+[^\s]+/gi,
    /(?:api[_-]?key|apikey|secret)[\s:=]+[^\s]+/gi,
    /(?:token|auth)[\s:=]+[^\s]+/gi,
    /\b\d{13,19}\b/g,
    /\b\d{17}[\dXx]\b/g,
    /1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}/g,
  ],
};

class SecurityManager {
  private config: SecurityConfig;
  private requestLog: Map<string, number[]> = new Map();
  private operationLog: LogEntry[] = [];

  constructor() {
    this.config = this.loadConfig();
    this.cleanupOldLogs();
  }

  private loadConfig(): SecurityConfig {
    try {
      const saved = localStorage.getItem("paw_security_config");
      if (saved) return { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
    } catch {}
    return DEFAULT_CONFIG;
  }

  private saveConfig(): void {
    localStorage.setItem("paw_security_config", JSON.stringify(this.config));
  }

  updateConfig(updates: Partial<SecurityConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveConfig();
  }

  filterPrivacy(text: string): string {
    if (!this.config.enablePrivacyFilter) return text;

    let filtered = text;
    for (const pattern of this.config.sensitivePatterns) {
      const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, "gi");
      filtered = filtered.replace(regex, (match) => {
        if (match.length <= 8) return "*".repeat(match.length);
        return `${match.slice(0, 2)}${"*".repeat(match.length - 4)}${match.slice(-2)}`;
      });
    }
    return filtered;
  }

  detectPrivacyRisk(text: string): { risk: "low" | "medium" | "high"; matches: string[] } {
    const matches: string[] = [];
    for (const pattern of this.config.sensitivePatterns) {
      const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, "gi");
      const found = text.match(regex);
      if (found) matches.push(...found);
    }

    if (matches.length === 0) return { risk: "low", matches: [] };
    if (matches.length <= 2) return { risk: "medium", matches };
    return { risk: "high", matches };
  }

  validateInput(input: string): ValidationResult {
    if (!this.config.enableInputValidation) {
      return { valid: true, sanitized: input };
    }

    if (input.length > 10000) {
      return { valid: false, error: "输入内容过长，请缩短后重试。" };
    }

    if (!input.trim()) {
      return { valid: false, error: "请输入内容。" };
    }

    const xssPatterns = [/<script/i, /javascript:/i, /on\w+\s*=/i, /<iframe/i, /<object/i, /<embed/i];
    for (const pattern of xssPatterns) {
      if (pattern.test(input)) {
        return { valid: false, error: "输入包含不安全的脚本内容，已被拦截。" };
      }
    }

    let sanitized = input.replace(/<[^>]*>/g, "");
    sanitized = sanitized.replace(/javascript:/gi, "");
    sanitized = sanitized.trim();
    return { valid: true, sanitized };
  }

  checkRateLimit(identifier = "default"): boolean {
    if (!this.config.enableRateLimiting) return true;

    const now = Date.now();
    const windowMs = 60 * 1000;
    if (!this.requestLog.has(identifier)) {
      this.requestLog.set(identifier, []);
    }

    const requests = this.requestLog.get(identifier)!;
    const recent = requests.filter((time) => now - time < windowMs);
    this.requestLog.set(identifier, recent);

    if (recent.length >= this.config.maxRequestsPerMinute) {
      this.log("warn", "system", "Rate limit exceeded", { identifier, count: recent.length });
      return false;
    }

    recent.push(now);
    this.requestLog.set(identifier, recent);
    return true;
  }

  getRateLimitStatus(identifier = "default"): { remaining: number; resetIn: number } {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const requests = this.requestLog.get(identifier) || [];
    const recent = requests.filter((time) => now - time < windowMs);
    const oldestInWindow = recent.length > 0 ? Math.min(...recent) : now;
    return {
      remaining: Math.max(0, this.config.maxRequestsPerMinute - recent.length),
      resetIn: Math.max(0, windowMs - (now - oldestInWindow)),
    };
  }

  log(
    level: LogEntry["level"],
    category: LogEntry["category"],
    message: string,
    details?: Record<string, unknown>
  ): void {
    const safeDetails = details ? this.filterPrivacyObjects(details) : undefined;
    const entry: LogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      level,
      category,
      message: this.filterPrivacy(message),
      details: safeDetails,
      timestamp: new Date().toISOString(),
    };

    this.operationLog.push(entry);
    if (this.operationLog.length > 500) {
      this.operationLog = this.operationLog.slice(-500);
    }

    this.saveLogs();
    if (typeof window !== "undefined" && window.location.hostname === "localhost") {
      console.log(`[${category}] ${message}`, safeDetails || "");
    }
  }

  private filterPrivacyObjects(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        result[key] = this.filterPrivacy(value);
      } else if (typeof value === "object" && value !== null) {
        result[key] = this.filterPrivacyObjects(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private saveLogs(): void {
    try {
      const important = this.operationLog.filter((entry) => entry.level === "error" || entry.level === "warn");
      localStorage.setItem("paw_operation_logs", JSON.stringify(important.slice(-100)));
    } catch {}
  }

  private cleanupOldLogs(): void {
    try {
      const saved = localStorage.getItem("paw_operation_logs");
      if (!saved) return;
      const logs: LogEntry[] = JSON.parse(saved);
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const recent = logs.filter((entry) => new Date(entry.timestamp).getTime() > oneDayAgo);
      if (recent.length < logs.length) {
        localStorage.setItem("paw_operation_logs", JSON.stringify(recent));
      }
    } catch {}
  }

  getLogs(filter?: { level?: LogEntry["level"]; category?: LogEntry["category"]; since?: string }): LogEntry[] {
    let logs = [...this.operationLog];
    if (filter?.level) logs = logs.filter((entry) => entry.level === filter.level);
    if (filter?.category) logs = logs.filter((entry) => entry.category === filter.category);
    if (filter?.since) {
      const sinceTime = new Date(filter.since).getTime();
      logs = logs.filter((entry) => new Date(entry.timestamp).getTime() > sinceTime);
    }
    return logs.reverse();
  }

  getErrorSummary(): { total: number; byCategory: Record<string, number> } {
    const errors = this.operationLog.filter((entry) => entry.level === "error");
    const byCategory: Record<string, number> = {};
    for (const log of errors) {
      byCategory[log.category] = (byCategory[log.category] || 0) + 1;
    }
    return { total: errors.length, byCategory };
  }

  async withRetry<T>(
    fn: () => Promise<T>,
    options: { maxRetries?: number; delayMs?: number; backoff?: boolean } = {}
  ): Promise<T> {
    const { maxRetries = 3, delayMs = 1000, backoff = true } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          const delay = backoff ? delayMs * Math.pow(2, attempt) : delayMs;
          this.log("warn", "system", `Retry ${attempt + 1}/${maxRetries} after error`, {
            error: (error as Error).message,
            delay,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    this.log("error", "system", "All retries failed", { error: lastError?.message });
    throw lastError;
  }

  withFallback<T>(primary: () => T, fallback: () => T, fallbackOn?: (e: unknown) => boolean): T {
    try {
      return primary();
    } catch (error) {
      if (!fallbackOn || fallbackOn(error)) {
        this.log("warn", "system", "Using fallback", { error: (error as Error).message });
        return fallback();
      }
      throw error;
    }
  }

  async safeExecuteTool(toolName: string, fn: () => Promise<string>): Promise<{ success: boolean; result: string }> {
    this.log("info", "tool", `Executing tool: ${toolName}`);
    try {
      if (!this.checkRateLimit(`tool_${toolName}`)) {
        const status = this.getRateLimitStatus(`tool_${toolName}`);
        return {
          success: false,
          result: `操作过于频繁，请在 ${Math.ceil(status.resetIn / 1000)} 秒后重试`,
        };
      }

      const result = await this.withRetry(fn, { maxRetries: 2, delayMs: 500 });
      personalityStore.recordToolUsage(toolName);
      this.log("info", "tool", `Tool ${toolName} completed`);
      return { success: true, result };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log("error", "tool", `Tool ${toolName} failed`, { error: errorMsg });
      return {
        success: false,
        result: `执行失败：${errorMsg}`,
      };
    }
  }
}

export const securityManager = new SecurityManager();
