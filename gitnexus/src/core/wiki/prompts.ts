/**
 * LLM Prompt Templates for Wiki Generation
 *
 * All prompts produce deterministic, source-grounded documentation in Chinese.
 * Templates use {{PLACEHOLDER}} substitution.
 */

// ─── Grouping Prompt ──────────────────────────────────────────────────

export const GROUPING_SYSTEM_PROMPT = `你是一名文档架构师。给定一批源文件及其导出的符号，将它们按逻辑归组为文档模块。

规则：
- 每个模块应代表一个内聚的功能、层次或领域
- 每个文件必须且只能出现在一个模块中
- 模块名称应通俗易懂（例如"用户认证"、"数据库层"、"API 路由"）
- 典型项目建议 5-15 个模块，小项目可以更少，大项目可以更多
- 按功能分组，而非单纯按文件类型或目录结构划分
- 不要为测试文件、配置文件或非源文件单独创建模块`;

export const GROUPING_USER_PROMPT = `将以下源文件归组为文档模块。

**文件及其导出符号：**
{{FILE_LIST}}

**目录结构：**
{{DIRECTORY_TREE}}

请只以 JSON 对象格式回复，将模块名映射到文件路径数组，不要包含 markdown 或任何说明文字。
示例格式：
{
  "用户认证": ["src/auth/login.ts", "src/auth/session.ts"],
  "数据库": ["src/db/connection.ts", "src/db/models.ts"]
}`;

// ─── Leaf Module Prompt ───────────────────────────────────────────────

export const MODULE_SYSTEM_PROMPT = `你是一名技术文档撰写人。请为一个代码模块撰写清晰、面向开发者的中文文档。

规则：
- 只输出文档内容本身，不要加"我已编写好……""以下是文档……"之类的前置说明
- 直接以模块标题和正文内容开始
- 引用真实的函数名、类名和代码模式，不要凭空捏造 API
- 参考调用图和执行流程数据确保准确，但不要机械地列举每条边
- 仅在 Mermaid 图确实有助于理解时才添加，保持简洁（最多 5-10 个节点）
- 根据模块特点自由决定文档结构，没有强制格式要求
- 文档应面向需要理解并参与这段代码开发的工程师`;

export const MODULE_USER_PROMPT = `为 **{{MODULE_NAME}}** 模块撰写中文文档。

## 源代码

{{SOURCE_CODE}}

## 调用图与执行流程（供参考，保证准确性）

模块内部调用：{{INTRA_CALLS}}
对外调用：{{OUTGOING_CALLS}}
被调用来源：{{INCOMING_CALLS}}
执行流程：{{PROCESSES}}

---

请为该模块撰写完整的中文文档，涵盖其用途、工作原理、核心组件以及与代码库其他部分的关联。文档结构由你决定。如果 Mermaid 图确实能帮助理解架构，可以酌情添加。`;

// ─── Parent Module Prompt ─────────────────────────────────────────────

export const PARENT_SYSTEM_PROMPT = `你是一名技术文档撰写人。请为包含若干子模块的父模块撰写中文摘要页。综合子模块文档进行整合，无需重新阅读源代码。

规则：
- 只输出文档内容本身，不要加任何前置说明
- 直接以模块标题和正文内容开始
- 引用子模块中的实际组件
- 重点说明子模块如何协同工作，不要重复各自的详情
- 保持简洁——读者可以点击子模块页面查看细节
- 仅在 Mermaid 图确实有助于说明子模块关系时才添加`;

export const PARENT_USER_PROMPT = `为 **{{MODULE_NAME}}** 模块撰写中文文档，该模块包含以下子模块：

{{CHILDREN_DOCS}}

跨模块调用：{{CROSS_MODULE_CALLS}}
共享执行流程：{{CROSS_PROCESSES}}

---

请撰写该模块组的简洁中文概述，说明其用途、各子模块如何组合以及跨子模块的关键工作流。使用链接引用子模块页面（例如 \`[子模块名](sub-module-slug.md)\`），而非重复其内容。`;

// ─── Overview Prompt ──────────────────────────────────────────────────

export const OVERVIEW_SYSTEM_PROMPT = `你是一名技术文档撰写人。请为代码仓库 Wiki 撰写顶层中文概览页。这是新开发者看到的第一个页面。

规则：
- 只输出文档内容本身，不要加任何前置说明
- 直接以项目标题和正文开始
- 清晰友好——这是整个代码库的入口
- 引用实际模块名，方便读者导航
- 包含一张高层次的 Mermaid 架构图，只展示最重要的模块及其关系（最多 10 个节点），新开发者能在 10 秒内理解
- 不要创建模块索引表或逐一列举所有模块的描述——在正文中自然地使用链接引用模块即可
- 使用模块间调用边和执行流程数据确保准确，不要原文照搬`;

export const OVERVIEW_USER_PROMPT = `为该代码仓库的 Wiki 撰写中文概览页。

## 项目信息

{{PROJECT_INFO}}

## 各模块摘要

{{MODULE_SUMMARIES}}

## 参考数据（用于保证准确性——不要逐字复制）

模块间调用边：{{MODULE_EDGES}}
主要系统流程：{{TOP_PROCESSES}}

---

请撰写一份清晰的中文概览：介绍项目的功能、架构以及主要端到端流程。包含一张简洁的 Mermaid 架构图（最多 10 个节点，只展示大图）。在正文中自然引用模块页面链接（例如 \`[模块名](module-slug.md)\`），而非通过表格列举。如果提供了项目配置信息，请附上简短的安装步骤。`;

// ─── Template Substitution Helper ─────────────────────────────────────

/**
 * Replace {{PLACEHOLDER}} tokens in a template string.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// ─── Formatting Helpers ───────────────────────────────────────────────

/**
 * Format file list with exports for the grouping prompt.
 */
export function formatFileListForGrouping(
  files: Array<{ filePath: string; symbols: Array<{ name: string; type: string }> }>,
): string {
  return files
    .map((f) => {
      const exports =
        f.symbols.length > 0
          ? f.symbols.map((s) => `${s.name} (${s.type})`).join(', ')
          : 'no exports';
      return `- ${f.filePath}: ${exports}`;
    })
    .join('\n');
}

/**
 * Build a directory tree string from file paths.
 */
export function formatDirectoryTree(filePaths: string[]): string {
  const dirs = new Set<string>();
  for (const fp of filePaths) {
    const parts = fp.replace(/\\/g, '/').split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }

  const sorted = Array.from(dirs).sort();
  if (sorted.length === 0) return '(flat structure)';

  return (
    sorted.slice(0, 50).join('\n') +
    (sorted.length > 50 ? `\n... and ${sorted.length - 50} more directories` : '')
  );
}

/**
 * Format call edges as readable text.
 */
export function formatCallEdges(
  edges: Array<{ fromFile: string; fromName: string; toFile: string; toName: string }>,
): string {
  if (edges.length === 0) return 'None';
  return edges
    .slice(0, 30)
    .map((e) => `${e.fromName} (${shortPath(e.fromFile)}) → ${e.toName} (${shortPath(e.toFile)})`)
    .join('\n');
}

/**
 * Format process traces as readable text.
 */
export function formatProcesses(
  processes: Array<{
    label: string;
    type: string;
    steps: Array<{ step: number; name: string; filePath: string }>;
  }>,
): string {
  if (processes.length === 0) return 'No execution flows detected for this module.';

  return processes
    .map((p) => {
      const stepsText = p.steps
        .map((s) => `  ${s.step}. ${s.name} (${shortPath(s.filePath)})`)
        .join('\n');
      return `**${p.label}** (${p.type}):\n${stepsText}`;
    })
    .join('\n\n');
}

/**
 * Shorten a file path for readability.
 */
function shortPath(fp: string): string {
  const parts = fp.replace(/\\/g, '/').split('/');
  return parts.length > 3 ? parts.slice(-3).join('/') : fp;
}
