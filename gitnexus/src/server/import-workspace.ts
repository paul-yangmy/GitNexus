import fs from 'fs/promises';
import path from 'path';
import extractZip from 'extract-zip';
import * as tar from 'tar';
import { fileURLToPath } from 'url';
import {
  buildGitRepoUrl,
  cloneRepositorySnapshot,
  ensureGitRepository,
  extractRepoName,
} from './git-clone.js';

export interface ImportedWorkspace {
  repoName: string;
  repoPath: string;
  workspaceRoot: string;
  sourceLabel: string;
  branch?: string;
}

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_REPOS_DIR = path.resolve(CURRENT_DIR, '../../../gitnexus-analyze');
export const getProductReposDir = (): string => PRODUCT_REPOS_DIR;

const buildTimestampSuffix = (now: Date = new Date()): string => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
};

type ArchiveFormat = 'zip' | 'tar.gz' | 'tar.bz2' | 'tar.xz' | 'tar' | 'unknown';

const detectArchiveFormat = (filename: string): ArchiveFormat => {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2') || lower.endsWith('.tb2')) return 'tar.bz2';
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) return 'tar.xz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.zip')) return 'zip';
  return 'unknown';
};

/** Strip known archive extension(s) from a filename, e.g. "repo.tar.gz" → "repo" */
const stripArchiveExtension = (basename: string): string => {
  return basename
    .replace(/\.(tar\.(gz|bz2|xz)|tgz|tbz2|tb2|txz|zip|tar)$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
};

const createTimestampedRepoName = (baseName: string): string => {
  const normalized = stripArchiveExtension(baseName) || 'uploaded-repo';
  return `${normalized}-${buildTimestampSuffix()}`;
};

const moveEntrySafely = async (fromPath: string, toPath: string): Promise<void> => {
  try {
    await fs.rename(fromPath, toPath);
    return;
  } catch (error: any) {
    if (!['EPERM', 'EACCES', 'EXDEV'].includes(error?.code)) {
      throw error;
    }
  }

  const stat = await fs.stat(fromPath);
  if (stat.isDirectory()) {
    await fs.cp(fromPath, toPath, { recursive: true, force: true });
    await fs.rm(fromPath, { recursive: true, force: true });
    return;
  }

  await fs.copyFile(fromPath, toPath);
  await fs.rm(fromPath, { force: true });
};

const moveContentsUp = async (fromDir: string, toDir: string): Promise<void> => {
  const entries = await fs.readdir(fromDir);
  for (const entry of entries) {
    await moveEntrySafely(path.join(fromDir, entry), path.join(toDir, entry));
  }
  await fs.rm(fromDir, { recursive: true, force: true });
};

const flattenSingleTopLevelDirectory = async (targetDir: string): Promise<void> => {
  let depth = 0;

  while (depth < 10) {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    const visibleEntries = entries.filter((entry) => entry.name !== '__MACOSX');
    const directories = visibleEntries.filter((entry) => entry.isDirectory());
    const files = visibleEntries.filter((entry) => entry.isFile());

    if (files.length > 0 || directories.length !== 1) {
      return;
    }

    const wrapperDir = path.join(targetDir, directories[0].name);
    console.log(`[product-import] flatten wrapper directory: ${wrapperDir}`);
    await moveContentsUp(wrapperDir, targetDir);
    depth += 1;
  }

  console.warn(`[product-import] stopped flattening after ${depth} nested wrapper directories`);
};

export const prepareArchiveWorkspace = async (
  archiveBuffer: Buffer,
  originalFilename: string,
): Promise<ImportedWorkspace> => {
  const format = detectArchiveFormat(originalFilename);
  if (format === 'unknown') {
    throw new Error(
      `Unsupported archive format: "${originalFilename}". Supported: .zip, .tar.gz, .tgz, .tar.bz2, .tbz2, .tar.xz, .txz, .tar`,
    );
  }

  const derivedName = stripArchiveExtension(path.basename(originalFilename));
  const repoName = createTimestampedRepoName(derivedName);
  const repoPath = path.join(PRODUCT_REPOS_DIR, repoName);

  // Preserve the original extension so extractors can detect compression
  const ext = originalFilename.replace(/^.*?(\.(tar\.gz|tgz|tar\.bz2|tbz2|tb2|tar\.xz|txz|tar|zip))$/i, '$1') || '.archive';
  const archivePath = path.join(PRODUCT_REPOS_DIR, `${repoName}${ext.startsWith('.') ? ext : `.${ext}`}`);

  await fs.mkdir(PRODUCT_REPOS_DIR, { recursive: true });
  await fs.mkdir(repoPath, { recursive: true });
  console.log(`[product-import] archive received: ${originalFilename} (format: ${format})`);
  console.log(`[product-import] workspace root: ${PRODUCT_REPOS_DIR}`);
  console.log(`[product-import] target path: ${repoPath}`);
  await fs.writeFile(archivePath, archiveBuffer);

  try {
    if (format === 'zip') {
      await extractZip(archivePath, { dir: repoPath });
    } else {
      // tar, tar.gz, tar.bz2, tar.xz — node-tar handles gz and bz2 natively
      await tar.extract({ file: archivePath, cwd: repoPath });
    }
    console.log(`[product-import] archive extracted to: ${repoPath}`);
  } finally {
    await fs.rm(archivePath, { force: true }).catch(() => {});
  }

  await flattenSingleTopLevelDirectory(repoPath);
  console.log('[product-import] checking git repository state...');
  await ensureGitRepository(repoPath);
  console.log('[product-import] git repository ready');

  return {
    repoName,
    repoPath,
    workspaceRoot: PRODUCT_REPOS_DIR,
    sourceLabel: originalFilename,
  };
};

export const prepareGitWorkspace = async (
  repoNameOrSlug: string,
  branch: string,
): Promise<ImportedWorkspace> => {
  const repoUrl = buildGitRepoUrl(repoNameOrSlug);
  const baseRepoName = extractRepoName(repoUrl);
  const repoName = createTimestampedRepoName(baseRepoName);
  const repoPath = path.join(PRODUCT_REPOS_DIR, repoName);

  await fs.mkdir(PRODUCT_REPOS_DIR, { recursive: true });
  console.log(`[product-import] git source: ${repoNameOrSlug}#${branch}`);
  console.log(`[product-import] workspace root: ${PRODUCT_REPOS_DIR}`);
  console.log(`[product-import] target path: ${repoPath}`);

  await cloneRepositorySnapshot(repoUrl, repoPath, branch);
  console.log('[product-import] repository cloned locally');

  return {
    repoName,
    repoPath,
    workspaceRoot: PRODUCT_REPOS_DIR,
    sourceLabel: repoNameOrSlug,
    branch,
  };
};
