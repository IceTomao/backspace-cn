import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export interface ActivityAssetCleanupResult {
  deletedFiles: number;
  freedBytes: number;
  remainingBytes: number;
}

/** Expire transient rich-presence artwork, then enforce the instance-wide cap oldest-first. */
export function cleanupActivityAssets(now: number = Date.now()): ActivityAssetCleanupResult {
  const result: ActivityAssetCleanupResult = { deletedFiles: 0, freedBytes: 0, remainingBytes: 0 };
  let files: Array<{ full: string; size: number; modifiedAt: number }> = [];
  try {
    files = fs.readdirSync(config.activityAssetDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.webp$/.test(entry.name))
      .flatMap((entry) => {
        try {
          const full = path.join(config.activityAssetDir, entry.name);
          const stat = fs.statSync(full);
          return [{ full, size: stat.size, modifiedAt: stat.mtimeMs }];
        } catch { return []; }
      });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }

  const remove = (file: { full: string; size: number }): boolean => {
    try {
      fs.unlinkSync(file.full);
      result.deletedFiles++;
      result.freedBytes += file.size;
      return true;
    } catch { return false; }
  };

  const retained = files.filter((file) => now - file.modifiedAt <= config.activityAssetTtlMs || !remove(file));
  let total = retained.reduce((sum, file) => sum + file.size, 0);
  for (const file of retained.sort((a, b) => a.modifiedAt - b.modifiedAt)) {
    if (total <= config.activityAssetMaxBytes) break;
    if (remove(file)) total -= file.size;
  }
  result.remainingBytes = total;
  return result;
}
