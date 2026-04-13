import crypto from 'crypto';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import archiver from 'archiver';
import archiverZipEncrypted from 'archiver-zip-encrypted';

archiver.registerFormat('zip-encrypted', archiverZipEncrypted);
import { loadMeta, getStoragePath, type RepoMeta } from '../storage/repo-manager.js';
import { generateHTMLViewer } from '../core/wiki/html-viewer.js';
import type { LocalBackend } from '../mcp/local/local-backend.js';
import type { ProductSourceType } from './product-history.js';

interface ModuleTreeNode {
  name: string;
  slug: string;
  files: string[];
  children?: ModuleTreeNode[];
}

export interface ChineseWikiArtifacts {
  wikiDir: string;
  wikiBundlePath: string;
  wikiPassword: string;
  stats?: RepoMeta['stats'];
}

interface GenerateChineseWikiOptions {
  backend: LocalBackend;
  repoName: string;
  repoPath: string;
  sourceType: ProductSourceType;
  sourceLabel: string;
  branch?: string;
  mcpEndpoint: string;
}

const slugify = (value: string): string => {
  // Keep CJK characters (\u4e00-\u9fff), letters, and digits; replace others with hyphens
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!slug) {
    return 'module-' + crypto.createHash('md5').update(value).digest('hex').slice(0, 8);
  }
  return slug;
};

export const createWikiPassword = (): string => {
  return crypto.randomBytes(12).toString('base64url');
};

const summarizeList = (values: string[], fallback: string): string => {
  if (values.length === 0) return fallback;
  return values.map((value) => `- ${value}`).join('\n');
};

const buildOverviewMarkdown = ({
  repoName,
  sourceType,
  sourceLabel,
  branch,
  meta,
  clusters,
  processes,
  mcpEndpoint,
}: {
  repoName: string;
  sourceType: ProductSourceType;
  sourceLabel: string;
  branch?: string;
  meta: RepoMeta | null;
  clusters: Array<{ label: string; symbolCount?: number; heuristicLabel?: string }>;
  processes: Array<{ label: string; stepCount?: number; heuristicLabel?: string }>;
  mcpEndpoint: string;
}): string => {
  const stats = meta?.stats ?? {};
  const topClusters = clusters
    .slice(0, 6)
    .map((cluster) => `${cluster.heuristicLabel || cluster.label}（${cluster.symbolCount ?? 0} 个符号）`);
  const topProcesses = processes
    .slice(0, 5)
    .map((process) => `${process.heuristicLabel || process.label}（${process.stepCount ?? 0} 步）`);

  return `# ${repoName} 中文 Wiki

## 项目概览

- 导入来源：${sourceType === 'archive' ? '压缩包上传' : 'Git 仓库'}
- 来源标识：\`${sourceLabel}\`
${branch ? `- 分支：\`${branch}\`\n` : ''}- GitNexus 索引时间：${meta?.indexedAt ?? '未知'}
- 代码文件数：${stats.files ?? 0}
- 图谱节点数：${stats.nodes ?? 0}
- 图谱关系数：${stats.edges ?? 0}
- 功能簇数：${stats.communities ?? 0}
- 执行流程数：${stats.processes ?? 0}

## 核心功能簇

${summarizeList(topClusters, '- 当前没有识别出明确的功能簇')}

## 关键执行流程

${summarizeList(topProcesses, '- 当前没有识别出明确的执行流程')}

## MCP 服务接入

- MCP Streamable HTTP 端点：\`${mcpEndpoint}\`
- 目标仓库参数：\`${repoName}\`
- 接入建议：初始化 MCP 会话后，在工具调用中传入仓库名 \`${repoName}\`，即可对这一份解析结果进行查询、影响面分析和流程追踪。

## 使用建议

1. 先阅读“功能簇”页面，快速建立系统边界感。
2. 再阅读“执行流程”页面，理解主路径上的调用链。
3. 如果需要让外部智能体使用解析结果，请优先通过 MCP 服务访问，而不是直接消费原始图数据。
`;
};

const buildClusterMarkdown = (
  cluster: { label: string; heuristicLabel?: string; cohesion?: number; symbolCount?: number },
  members: Array<{ name: string; type: string; filePath: string }>,
): string => {
  return `# ${cluster.heuristicLabel || cluster.label}

## 中文说明

- 原始标签：\`${cluster.label}\`
- 凝聚度：${(cluster.cohesion ?? 0).toFixed(2)}
- 涉及符号数：${cluster.symbolCount ?? members.length}

## 代表性符号

${summarizeList(
    members.slice(0, 20).map((member) => `${member.name} · ${member.type} · \`${member.filePath}\``),
    '- 暂无成员详情',
  )}

## 阅读建议

- 先关注该功能簇中出现频率最高的文件与函数名。
- 如果要做改动，优先结合 GitNexus 图谱继续查看它与其他簇之间的调用关系。
`;
};

const buildProcessMarkdown = (
  process: { label: string; heuristicLabel?: string; processType?: string; stepCount?: number },
  steps: Array<{ step: number; name: string; type: string; filePath: string }>,
): string => {
  const orderedSteps = [...steps].sort((a, b) => a.step - b.step);
  return `# ${process.heuristicLabel || process.label}

## 中文说明

- 原始标签：\`${process.label}\`
- 流程类型：${process.processType ?? '未知'}
- 步骤数：${process.stepCount ?? orderedSteps.length}

## 流程步骤

${summarizeList(
    orderedSteps.map((step) => `第 ${step.step} 步：${step.name} · ${step.type} · \`${step.filePath}\``),
    '- 暂无流程步骤',
  )}

## 阅读建议

- 这个页面适合拿来理解请求、任务或消息在系统中的主链路。
- 如果某一步需要修改，可以回到图谱视图中定位对应节点，再查看上下游关系。
`;
};

export const createEncryptedBundle = async (
  wikiDir: string,
  repoName: string,
  password: string,
): Promise<string> => {
  const outputPath = path.join(wikiDir, `${repoName}-wiki.zip`);

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver.create('zip-encrypted' as any, {
      zlib: { level: 9 },
      encryptionMethod: 'aes256',
      password,
    } as any);

    output.on('close', () => resolve());
    archive.on('error', (err: Error) => reject(err));

    archive.pipe(output);
    archive.directory(wikiDir, false, (entry) => {
      // Exclude the output zip itself and any previous .enc files
      if (entry.name.endsWith('.zip') || entry.name.endsWith('.enc')) {
        return false as any;
      }
      return entry;
    });
    void archive.finalize();
  });

  return outputPath;
};

export const generateChineseWikiArtifacts = async (
  options: GenerateChineseWikiOptions,
): Promise<ChineseWikiArtifacts> => {
  const storagePath = getStoragePath(options.repoPath);
  const wikiDir = path.join(storagePath, 'product-wiki');
  await fs.mkdir(wikiDir, { recursive: true });

  const meta = await loadMeta(storagePath);
  const clusterSummary = await options.backend.queryClusters(options.repoName, 8);
  const processSummary = await options.backend.queryProcesses(options.repoName, 6);

  const moduleTree: ModuleTreeNode[] = [
    { name: '概览', slug: 'overview', files: [] },
    {
      name: '功能簇',
      slug: 'capabilities',
      files: [],
      children: clusterSummary.clusters.map((cluster: any) => ({
        name: cluster.heuristicLabel || cluster.label,
        slug: slugify(cluster.heuristicLabel || cluster.label),
        files: [],
      })),
    },
    {
      name: '执行流程',
      slug: 'processes',
      files: [],
      children: processSummary.processes.map((process: any) => ({
        name: process.heuristicLabel || process.label,
        slug: slugify(process.heuristicLabel || process.label),
        files: [],
      })),
    },
    {
      name: 'MCP 服务',
      slug: 'mcp-service',
      files: [],
    },
  ];

  await fs.writeFile(
    path.join(wikiDir, 'overview.md'),
    buildOverviewMarkdown({
      repoName: options.repoName,
      sourceType: options.sourceType,
      sourceLabel: options.sourceLabel,
      branch: options.branch,
      meta,
      clusters: clusterSummary.clusters,
      processes: processSummary.processes,
      mcpEndpoint: options.mcpEndpoint,
    }),
    'utf-8',
  );

  await fs.writeFile(
    path.join(wikiDir, 'capabilities.md'),
    `# 功能簇导航

以下页面按 GitNexus 自动识别出的高价值功能簇整理。建议优先阅读符号数较多、凝聚度较高的模块，以便更快建立系统边界感。

${summarizeList(
      clusterSummary.clusters.map(
        (cluster: any) =>
          `${cluster.heuristicLabel || cluster.label}（${cluster.symbolCount ?? 0} 个符号）`,
      ),
      '- 当前没有识别出功能簇',
    )}
`,
    'utf-8',
  );

  await fs.writeFile(
    path.join(wikiDir, 'processes.md'),
    `# 执行流程导航

以下流程按步骤数排序，适合用于快速理解系统中的主链路、入口点以及跨模块协作方式。

${summarizeList(
      processSummary.processes.map(
        (process: any) =>
          `${process.heuristicLabel || process.label}（${process.stepCount ?? 0} 步）`,
      ),
      '- 当前没有识别出执行流程',
    )}
`,
    'utf-8',
  );

  for (const cluster of clusterSummary.clusters) {
    const detail = await options.backend.queryClusterDetail(cluster.label, options.repoName);
    await fs.writeFile(
      path.join(wikiDir, `${slugify(cluster.heuristicLabel || cluster.label)}.md`),
      buildClusterMarkdown(cluster, detail.members ?? []),
      'utf-8',
    );
  }

  for (const process of processSummary.processes) {
    const detail = await options.backend.queryProcessDetail(process.label, options.repoName);
    await fs.writeFile(
      path.join(wikiDir, `${slugify(process.heuristicLabel || process.label)}.md`),
      buildProcessMarkdown(process, detail.steps ?? []),
      'utf-8',
    );
  }

  await fs.writeFile(
    path.join(wikiDir, 'mcp-service.md'),
    `# ${options.repoName} 的 MCP 服务

## 接入信息

- Streamable HTTP 地址：\`${options.mcpEndpoint}\`
- 仓库参数：\`${options.repoName}\`
- 适用场景：代码检索、上下文查询、影响面分析、执行流程追踪

## 使用说明

1. 使用支持 MCP 的客户端连接到上述 HTTP 端点。
2. 在请求工具时，将 \`repo\` 参数设置为 \`${options.repoName}\`。
3. 常用查询包括：\`query\`、\`context\`、\`impact\`、\`detect_changes\`。

## 建议

- 如果这份仓库后续重新上传并再次解析，会生成新的时间戳仓库名，请使用历史记录中展示的最新仓库名。
- 如果需要和中文 wiki 对照阅读，优先从“概览”页进入，再跳到对应的功能簇或执行流程页面。
`,
    'utf-8',
  );

  await fs.writeFile(
    path.join(wikiDir, 'module_tree.json'),
    JSON.stringify(moduleTree.filter((node) => node.slug !== 'overview'), null, 2),
    'utf-8',
  );

  await fs.writeFile(
    path.join(wikiDir, 'meta.json'),
    JSON.stringify(
      {
        fromCommit: meta?.lastCommit ?? '',
        generatedAt: new Date().toISOString(),
        model: 'GitNexus Product Chinese Wiki',
      },
      null,
      2,
    ),
    'utf-8',
  );

  await generateHTMLViewer(wikiDir, `${options.repoName} 中文 Wiki`);

  const wikiPassword = createWikiPassword();
  const wikiBundlePath = await createEncryptedBundle(wikiDir, options.repoName, wikiPassword);

  return {
    wikiDir,
    wikiBundlePath,
    wikiPassword,
    stats: meta?.stats,
  };
};
