import fs from 'fs/promises';
import path from 'path';
import { getGlobalDir, type RepoMeta } from '../storage/repo-manager.js';

export type ProductSourceType = 'archive' | 'git';

export interface PreviousVersion {
  id: string;
  importedAt: string;
  repoPath?: string;
  wikiDir: string;
  wikiBundlePath: string;
  wikiPassword: string;
  stats?: RepoMeta['stats'];
}

export interface ProductHistoryEntry {
  id: string;
  userId: string;
  userName?: string;
  repoName: string;
  repoPath: string;
  sourceType: ProductSourceType;
  sourceLabel: string;
  branch?: string;
  importedAt: string;
  updatedAt?: string;
  /** Empty string or undefined until wiki generation completes. */
  wikiDir?: string;
  wikiBundlePath?: string;
  wikiPassword?: string;
  mcpEndpoint: string;
  mcpRepoName: string;
  stats?: RepoMeta['stats'];
  previousVersions?: PreviousVersion[];
}

const PRODUCT_HISTORY_FILE = 'product-history.json';

export const getProductHistoryPath = (): string => {
  return path.join(getGlobalDir(), PRODUCT_HISTORY_FILE);
};

export const readProductHistory = async (): Promise<ProductHistoryEntry[]> => {
  try {
    const raw = await fs.readFile(getProductHistoryPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProductHistoryEntry[]) : [];
  } catch {
    return [];
  }
};

export const writeProductHistory = async (entries: ProductHistoryEntry[]): Promise<void> => {
  const historyPath = getProductHistoryPath();
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(historyPath, JSON.stringify(entries, null, 2), 'utf-8');
};

export const upsertProductHistoryEntry = async (entry: ProductHistoryEntry): Promise<void> => {
  const existing = await readProductHistory();

  // Find existing entry for the same user + repo to support incremental updates
  const existingIdx = existing.findIndex(
    (item) => item.userId === entry.userId && item.repoName === entry.repoName,
  );

  let merged: ProductHistoryEntry;
  if (existingIdx >= 0) {
    const old = existing[existingIdx];
    // Archive the old version before overwriting
    const prevVersion: PreviousVersion = {
      id: old.id,
      importedAt: old.importedAt,
      repoPath: old.repoPath,
      wikiDir: old.wikiDir ?? '',
      wikiBundlePath: old.wikiBundlePath ?? '',
      wikiPassword: old.wikiPassword ?? '',
      stats: old.stats,
    };
    const previousVersions = [...(old.previousVersions ?? [])];
    previousVersions.unshift(prevVersion);

    merged = {
      ...entry,
      id: old.id, // keep the original id for stable references
      previousVersions,
      updatedAt: new Date().toISOString(),
    };
    existing.splice(existingIdx, 1);
  } else {
    merged = entry;
  }

  // Also remove any entry with the same id (defensive dedup)
  const next = existing.filter((item) => item.id !== merged.id);
  next.unshift(merged);
  next.sort((a, b) => {
    const aTime = a.updatedAt ?? a.importedAt;
    const bTime = b.updatedAt ?? b.importedAt;
    return new Date(bTime).getTime() - new Date(aTime).getTime();
  });
  await writeProductHistory(next);
};

export const listProductHistoryByUser = async (userId: string): Promise<ProductHistoryEntry[]> => {
  const entries = await readProductHistory();
  return entries.filter((entry) => entry.userId === userId);
};

export const findProductHistoryEntry = async (
  entryId: string,
): Promise<ProductHistoryEntry | null> => {
  const entries = await readProductHistory();
  return entries.find((entry) => entry.id === entryId) ?? null;
};

/**
 * Delete a history entry. Owners can delete their own entries; admins can
 * delete any entry.
 * Returns the deleted entry (or null if not found / not authorised).
 */
export const deleteProductHistoryEntry = async (
  entryId: string,
  userId: string,
  isAdmin: boolean,
): Promise<ProductHistoryEntry | null> => {
  const entries = await readProductHistory();
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx < 0) return null;
  const target = entries[idx];
  if (!isAdmin && target.userId !== userId) return null;
  entries.splice(idx, 1);
  await writeProductHistory(entries);
  return target;
};
