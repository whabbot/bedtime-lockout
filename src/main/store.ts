import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Atomic JSON key/value persistence under a directory (typically Electron's
 * userData path). Each key is stored as `<key>.json`. Writes go to a
 * `.tmp` file first, then `renameSync` swaps it into place — rename is
 * atomic on a given filesystem, so a crash mid-write can never leave a
 * truncated/corrupt `<key>.json` behind.
 */
export class Store {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private pathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  read<T>(key: string, fallback: T): T {
    const filePath = this.pathFor(key);
    if (!existsSync(filePath)) {
      return fallback;
    }
    try {
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  write(key: string, value: unknown): void {
    const filePath = this.pathFor(key);
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf-8");
    renameSync(tmpPath, filePath);
  }
}
