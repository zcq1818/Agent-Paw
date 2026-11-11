/**
 * 增强记忆系统
 * - 语义搜索
 * - 自动记忆提取
 * - 记忆分类和过期清理
 */

import { buildChatCompletionsUrl, buildRequestHeaders, getEmbeddingModel, loadConfig, parseConfigJson } from "./kernel";
import { scopeKey } from "./scope";

export type MemoryType = "preference" | "fact" | "habit" | "important" | "task";
export type MemoryPriority = "high" | "medium" | "low";

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  tags: string[];
  signature?: string;
  normalizedContent?: string;
  priority: MemoryPriority;
  embedding?: number[];
  importance: number;
  accessCount: number;
  lastAccessed: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
  byPriority: Record<MemoryPriority, number>;
  avgImportance: number;
}

const MAX_MEMORIES = 500;
const EMBEDDING_MODEL = "text-embedding-3-small";
const DEDUPE_MIGRATION_KEY = "paw_memory_dedupe_v2";
const AUTO_EXTRACT_PROMPT = `你是一个记忆管理助手。请分析对话内容，提取值得长期记忆的信息。

分析以下对话，提取：
1. 用户明确表达的个人偏好
2. 用户提到的习惯或行为模式
3. 用户认为重要的事实或事件
4. 未完成的任务或待办事项
5. 可能对未来对话有帮助的信息

对话内容：
{conversation}

请以 JSON 格式返回：
{
  "memories": [
    {
      "type": "preference|fact|habit|important|task",
      "content": "简短记忆内容",
      "tags": ["tag1", "tag2"],
      "importance": 0-10,
      "expiresIn": "never|7d|30d|90d"
    }
  ]
}

如果没有值得记忆的内容，请返回空数组。`;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const latin = lower.match(/[a-z0-9_]+/g) || [];
  const cjk = lower.match(/[\u4e00-\u9fff]/g) || [];
  return [...latin, ...cjk].filter(Boolean);
}

function lexicalScore(query: string, text: string, tags: string[] = []): number {
  const haystack = `${text} ${tags.join(" ")}`.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery.trim()) return 0;
  if (haystack.includes(lowerQuery)) return 10;

  const tokens = tokenize(lowerQuery);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

function getDaysUntilExpiry(expiresIn: string): number {
  switch (expiresIn) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    default:
      return -1;
  }
}

function normalizeMemoryContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_#>\[\]（）(){}，。！？!?:：；;、"'“”‘’]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function buildMemorySignature(type: MemoryType, content: string, tags: string[] = []) {
  const normalizedTags = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
  return [type, normalizeMemoryContent(content), normalizedTags.join("|")].join("::");
}

function jaccardSimilarity(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function isLikelyDuplicateMemory(a: Memory | Pick<Memory, "content" | "type" | "tags">, b: Pick<Memory, "content" | "type" | "tags">): boolean {
  const aKey = normalizeMemoryContent(a.content);
  const bKey = normalizeMemoryContent(b.content);
  if (!aKey || !bKey) return false;
  if (aKey === bKey) return true;
  if (aKey.length >= 12 && bKey.length >= 12 && (aKey.includes(bKey) || bKey.includes(aKey))) return true;
  if (a.type === b.type && jaccardSimilarity(a.content, b.content) >= 0.82) return true;
  const sharedTags = a.tags?.some((tag) => b.tags?.includes(tag));
  return Boolean(sharedTags && jaccardSimilarity(a.content, b.content) >= 0.72);
}

function priorityRank(priority: MemoryPriority) {
  return priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}

function mergePriority(a: MemoryPriority, b: MemoryPriority): MemoryPriority {
  return priorityRank(a) >= priorityRank(b) ? a : b;
}

class MemoryStore {
  /** 默认 Bot 用原库（保留既有记忆），其他 Bot 各开一个独立 IndexedDB 库。 */
  private get dbName(): string {
    return scopeKey("paw_memory_v2");
  }
  private storeName = "memories";
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.getDB();
    this.initialized = true;
    if (localStorage.getItem(DEDUPE_MIGRATION_KEY) !== "1") {
      this.cleanupDuplicates()
        .then(() => localStorage.setItem(DEDUPE_MIGRATION_KEY, "1"))
        .catch(() => {});
    }
  }

  private getDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 3);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: "id" });
          store.createIndex("type", "type", { unique: false });
          store.createIndex("priority", "priority", { unique: false });
          store.createIndex("importance", "importance", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
          store.createIndex("expiresAt", "expiresAt", { unique: false });
          store.createIndex("signature", "signature", { unique: false });
          store.createIndex("normalizedContent", "normalizedContent", { unique: false });
          return;
        }

        const tx = request.transaction;
        if (!tx) return;
        const store = tx.objectStore(this.storeName);
        if (!store.indexNames.contains("type")) store.createIndex("type", "type", { unique: false });
        if (!store.indexNames.contains("priority")) store.createIndex("priority", "priority", { unique: false });
        if (!store.indexNames.contains("importance")) store.createIndex("importance", "importance", { unique: false });
        if (!store.indexNames.contains("createdAt")) store.createIndex("createdAt", "createdAt", { unique: false });
        if (!store.indexNames.contains("expiresAt")) store.createIndex("expiresAt", "expiresAt", { unique: false });
        if (!store.indexNames.contains("signature")) store.createIndex("signature", "signature", { unique: false });
        if (!store.indexNames.contains("normalizedContent")) store.createIndex("normalizedContent", "normalizedContent", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async getBySignature(signature: string): Promise<Memory | undefined> {
    await this.init();
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.index("signature").get(signature);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private buildStoredMemory(
    memory: Omit<Memory, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessed">
  ): Memory {
    const now = new Date().toISOString();
    const normalizedContent = normalizeMemoryContent(memory.content);
    return {
      ...memory,
      signature: memory.signature || buildMemorySignature(memory.type, memory.content, memory.tags),
      normalizedContent: memory.normalizedContent || normalizedContent,
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      accessCount: 0,
      lastAccessed: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  private mergeMemory(
    existing: Memory,
    incoming: Omit<Memory, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessed">
  ): Partial<Memory> {
    const mergedTags = Array.from(new Set([...(existing.tags || []), ...(incoming.tags || [])]));
    const existingNorm = normalizeMemoryContent(existing.content);
    const incomingNorm = normalizeMemoryContent(incoming.content);
    const nextContent =
      incoming.content.length > existing.content.length && !incomingNorm.includes(existingNorm) ? incoming.content : existing.content;

    return {
      content: nextContent,
      tags: mergedTags,
      signature: buildMemorySignature(existing.type, nextContent, mergedTags),
      normalizedContent: normalizeMemoryContent(nextContent),
      priority: mergePriority(existing.priority, incoming.priority),
      importance: Math.max(existing.importance, incoming.importance),
      embedding: existing.embedding || incoming.embedding,
      expiresAt: existing.expiresAt || incoming.expiresAt,
      accessCount: existing.accessCount + 1,
      lastAccessed: new Date().toISOString(),
    };
  }

  async findSimilarMemory(
    memory: Omit<Memory, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessed">
  ): Promise<Memory | undefined> {
    const exact = await this.getBySignature(buildMemorySignature(memory.type, memory.content, memory.tags));
    if (exact) return exact;

    const candidates = await this.search(memory.content, 5);
    return candidates.find((item) => isLikelyDuplicateMemory(item, memory));
  }

  async getAll(): Promise<Memory[]> {
    await this.init();
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async get(id: string): Promise<Memory | undefined> {
    await this.init();
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async add(
    memory: Omit<Memory, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessed">
  ): Promise<Memory> {
    await this.init();
    const duplicate = await this.findSimilarMemory(memory);
    if (duplicate) {
      const updated = await this.update(duplicate.id, this.mergeMemory(duplicate, memory));
      if (updated) return updated;
    }

    const db = await this.getDB();
    const newMemory = this.buildStoredMemory(memory);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.add(newMemory);
      request.onsuccess = () => {
        this.enforceMaxMemories().catch(() => {});
        resolve(newMemory);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async update(id: string, updates: Partial<Memory>): Promise<Memory | undefined> {
    await this.init();
    const existing = await this.get(id);
    if (!existing) return undefined;

    const updated: Memory = {
      ...existing,
      ...updates,
      id,
      signature: updates.signature || existing.signature || buildMemorySignature(existing.type, updates.content || existing.content, updates.tags || existing.tags),
      normalizedContent: updates.normalizedContent || existing.normalizedContent || normalizeMemoryContent(updates.content || existing.content),
      updatedAt: new Date().toISOString(),
    };

    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.put(updated);
      request.onsuccess = () => resolve(updated);
      request.onerror = () => reject(request.error);
    });
  }

  async delete(id: string): Promise<void> {
    await this.init();
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async search(query: string, limit = 10): Promise<Memory[]> {
    await this.init();
    const all = await this.getAll();
    const now = new Date();
    const valid = all.filter((memory) => !memory.expiresAt || new Date(memory.expiresAt) > now);
    if (valid.length === 0) return [];

    const lowerQuery = query.toLowerCase();
    const keywordMatches = valid
      .map((memory) => ({ memory, score: lexicalScore(query, memory.content, memory.tags) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score + b.memory.importance / 20 - (a.score + a.memory.importance / 20))
      .map((item) => item.memory);

    const queryEmbedding = await this.getEmbedding(query);
    if (queryEmbedding) {
      const scored = valid.map((memory) => ({
        memory,
        score: memory.embedding ? cosineSimilarity(queryEmbedding, memory.embedding) : 0,
        keywordScore: lexicalScore(query, memory.content, memory.tags),
      }));

      const ranked = scored
        .sort((a, b) => b.score + b.keywordScore - (a.score + a.keywordScore))
        .slice(0, limit)
        .map((item) => item.memory);

      return ranked.length > 0 ? ranked : keywordMatches.slice(0, limit);
    }

    if (keywordMatches.length > 0) return keywordMatches.slice(0, limit);
    return valid
      .sort(
        (a, b) =>
          b.importance + b.accessCount * 0.2 + new Date(b.updatedAt).getTime() / 1e13 -
          (a.importance + a.accessCount * 0.2 + new Date(a.updatedAt).getTime() / 1e13)
      )
      .slice(0, Math.min(limit, 3));
  }

  async getRelevantContext(query: string, maxTokens = 1000): Promise<string> {
    const memories = await this.search(query, 5);
    if (memories.length === 0) return "";

    let context = "## 相关记忆\n";
    let totalLength = 0;
    for (const memory of memories) {
      const text = `[${memory.type}] ${memory.content}`;
      if (totalLength + text.length > maxTokens * 4) break;
      context += `- ${text}\n`;
      totalLength += text.length;
      this.update(memory.id, {
        accessCount: memory.accessCount + 1,
        lastAccessed: new Date().toISOString(),
      }).catch(() => {});
    }
    return context;
  }

  async extractAndSaveMemories(conversation: string): Promise<Memory[]> {
    const config = loadConfig();
    if (!config.apiKey) return [];

    try {
      const prompt = AUTO_EXTRACT_PROMPT.replace("{conversation}", conversation);
      const resp = await fetch(buildChatCompletionsUrl(config), {
        method: "POST",
        headers: buildRequestHeaders(config),
        body: JSON.stringify({
          ...parseConfigJson(config.extraBody),
          model: config.model,
          messages: [
            { role: "system", content: "请严格返回 JSON。不要输出多余文字。" },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 1000,
        }),
      });

      if (!resp.ok) return [];
      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content || "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.memories || !Array.isArray(parsed.memories)) return [];

      const newMemories: Memory[] = [];
      for (const item of parsed.memories) {
        const candidateEmbedding = await this.getEmbedding(item.content);
        const existing = await this.search(item.content, 5);
        const isDuplicate =
          candidateEmbedding !== undefined &&
          existing.some((memory) => memory.embedding && cosineSimilarity(candidateEmbedding, memory.embedding) > 0.95);

        if (isDuplicate) continue;

        const expiresIn = getDaysUntilExpiry(item.expiresIn || "never");
        const saved = await this.add({
          type: item.type || "fact",
          content: item.content,
          tags: item.tags || [],
          priority: item.importance >= 8 ? "high" : item.importance >= 5 ? "medium" : "low",
          importance: item.importance || 5,
          embedding: candidateEmbedding,
          expiresAt:
            expiresIn > 0
              ? new Date(Date.now() + expiresIn * 24 * 60 * 60 * 1000).toISOString()
              : undefined,
        });
        newMemories.push(saved);
      }

      return newMemories;
    } catch {
      return [];
    }
  }

  async cleanupExpired(): Promise<number> {
    await this.init();
    const all = await this.getAll();
    const now = new Date();
    let deleted = 0;
    for (const memory of all) {
      if (memory.expiresAt && new Date(memory.expiresAt) <= now) {
        await this.delete(memory.id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async cleanupDuplicates(): Promise<number> {
    await this.init();
    const all = await this.getAll();
    const sorted = all.sort((a, b) => {
      const scoreA = priorityRank(a.priority) * 10 + a.importance + a.accessCount * 0.2;
      const scoreB = priorityRank(b.priority) * 10 + b.importance + b.accessCount * 0.2;
      return scoreB - scoreA;
    });

    const keepers: Memory[] = [];
    let removed = 0;
    for (let memory of sorted) {
      if (!memory.signature || !memory.normalizedContent) {
        const normalizedContent = normalizeMemoryContent(memory.content);
        const next = await this.update(memory.id, {
          signature: buildMemorySignature(memory.type, memory.content, memory.tags),
          normalizedContent,
        });
        if (next) memory = next;
      }

      const duplicate = keepers.find((keeper) => keeper.signature === memory.signature || isLikelyDuplicateMemory(keeper, memory));
      if (!duplicate) {
        keepers.push(memory);
        continue;
      }

      await this.update(duplicate.id, this.mergeMemory(duplicate, memory));
      await this.delete(memory.id);
      removed += 1;
    }

    return removed;
  }

  async getStats(): Promise<MemoryStats> {
    const all = await this.getAll();
    const now = new Date();
    const valid = all.filter((memory) => !memory.expiresAt || new Date(memory.expiresAt) > now);

    const byType: Record<MemoryType, number> = {
      preference: 0,
      fact: 0,
      habit: 0,
      important: 0,
      task: 0,
    };
    const byPriority: Record<MemoryPriority, number> = {
      high: 0,
      medium: 0,
      low: 0,
    };

    let totalImportance = 0;
    for (const memory of valid) {
      byType[memory.type] += 1;
      byPriority[memory.priority] += 1;
      totalImportance += memory.importance;
    }

    return {
      total: valid.length,
      byType,
      byPriority,
      avgImportance: valid.length > 0 ? totalImportance / valid.length : 0,
    };
  }

  private async enforceMaxMemories(): Promise<void> {
    const all = await this.getAll();
    if (all.length <= MAX_MEMORIES) return;

    const priorityScore = { high: 3, medium: 2, low: 1 };
    const sorted = all.sort((a, b) => {
      const aScore = priorityScore[a.priority] * a.importance + a.accessCount;
      const bScore = priorityScore[b.priority] * b.importance + b.accessCount;
      return aScore - bScore;
    });

    const toDelete = sorted.slice(0, all.length - MAX_MEMORIES);
    for (const memory of toDelete) {
      await this.delete(memory.id);
    }
  }

  private async getEmbedding(text: string): Promise<number[] | undefined> {
    const config = loadConfig();
    if (!config.apiKey) return undefined;

    try {
      const resp = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: buildRequestHeaders(config),
        body: JSON.stringify({
          model: getEmbeddingModel(config) || EMBEDDING_MODEL,
          input: text.slice(0, 8000),
        }),
      });
      if (!resp.ok) return undefined;
      const data = await resp.json();
      return data.data?.[0]?.embedding;
    } catch {
      return undefined;
    }
  }
}

export const memoryStore = new MemoryStore();

export async function buildContext({
  userText,
  history,
}: {
  userText: string;
  history: Array<{ role: string; content: string }>;
}): Promise<string> {
  const memoryContext = await memoryStore.getRelevantContext(userText, 1000);
  const recentHistory = history
    .slice(-6)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  const parts = [
    memoryContext ? `\n${memoryContext}` : "",
    recentHistory ? `## 最近对话\n${recentHistory}` : "",
  ].filter(Boolean);

  return parts.join("\n\n");
}
