import path from 'path';
import { LocalBackend } from '../mcp/local/local-backend.js';
import {
  generateChineseWikiArtifacts,
  type ChineseWikiArtifacts,
} from '../server/chinese-wiki.js';
import type { ProductSourceType } from '../server/product-history.js';

export interface ProductBuildCommandOptions {
  repoName?: string;
  sourceType?: string;
  sourceLabel?: string;
  branch?: string;
  mcpEndpoint?: string;
}

export const PRODUCT_BUILD_RESULT_PREFIX = 'GITNEXUS_PRODUCT_BUILD_RESULT:';

const normalizeSourceType = (value?: string): ProductSourceType => {
  return value === 'archive' ? 'archive' : 'git';
};

const emitResult = (artifacts: ChineseWikiArtifacts): void => {
  console.log(`${PRODUCT_BUILD_RESULT_PREFIX}${JSON.stringify(artifacts)}`);
};

export const runProductBuildWorkflow = async (
  repoPath: string,
  options?: ProductBuildCommandOptions,
): Promise<ChineseWikiArtifacts> => {
  const resolvedRepoPath = path.resolve(repoPath || process.cwd());
  const repoName = options?.repoName?.trim() || path.basename(resolvedRepoPath);
  const sourceLabel = options?.sourceLabel?.trim() || repoName;
  const sourceType = normalizeSourceType(options?.sourceType);
  const mcpEndpoint = options?.mcpEndpoint?.trim();
  const branch = options?.branch?.trim() || undefined;

  if (!repoName) {
    throw new Error('missing --repo-name');
  }

  if (!mcpEndpoint) {
    throw new Error('missing --mcp-endpoint');
  }

  const backend = new LocalBackend();
  try {
    const hasRepos = await backend.init();
    if (!hasRepos) {
      throw new Error('No indexed repositories available. Run "gitnexus analyze" first.');
    }

    console.log(`[product-build] repo=${repoName}`);
    console.log(`[product-build] repoPath=${resolvedRepoPath}`);
    console.log(`[product-build] sourceType=${sourceType}`);

    return await generateChineseWikiArtifacts({
      backend,
      repoName,
      repoPath: resolvedRepoPath,
      sourceType,
      sourceLabel,
      branch,
      mcpEndpoint,
    });
  } finally {
    await backend.dispose().catch(() => {});
  }
};

export const productBuildCommand = async (
  inputPath?: string,
  options?: ProductBuildCommandOptions,
) => {
  try {
    const artifacts = await runProductBuildWorkflow(inputPath || process.cwd(), options);
    emitResult(artifacts);
  } catch (err: any) {
    console.error(`[product-build] failed: ${err?.message || 'Unknown error'}`);
    process.exitCode = 1;
  }
};
