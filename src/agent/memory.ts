/**
 * 记忆服务 — 本地持久化用户偏好和重要信息
 */

interface Memory {
  id: string;
  type: "preference" | "fact" | "note" | "reminder";
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

class MemoryStore {
  private dbName = "paw_memory";
  private storeName = "memories";

  private getDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAll(): Promise<Memory[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async add(memory: Omit<Memory, "id" | "createdAt" | "updatedAt">): Promise<Memory> {
    const now = new Date().toISOString();
    const newMemory: Memory = {
      ...memory,
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
    };

    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.add(newMemory);
      request.onsuccess = () => resolve(newMemory);
      request.onerror = () => reject(request.error);
    });
  }

  async search(query: string): Promise<Memory[]> {
    const all = await this.getAll();
    const lower = query.toLowerCase();
    return all.filter(
      (m) =>
        m.content.toLowerCase().includes(lower) ||
        m.tags.some((t) => t.toLowerCase().includes(lower))
    );
  }

  async delete(id: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

export const memoryStore = new MemoryStore();
