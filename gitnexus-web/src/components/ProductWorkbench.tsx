import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Eye,
  FolderGit2,
  GitBranch,
  History,
  Key,
  Loader2,
  Lock,
  PanelRightClose,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Trash2,
  Upload,
  User,
} from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import { createKnowledgeGraph } from '../core/graph/graph';
import { GraphCanvas } from './GraphCanvas';
import {
  connectToServer,
  createUser as createUserAccount,
  deleteProductHistory,
  downloadEncryptedWiki,
  fetchProductHistory,
  fetchRepos,
  fetchUsers,
  fetchWikiPreview,
  getBackendUrl,
  importArchive,
  importRepository,
  startAnalyze,
  startWikiAsync,
  streamAnalyzeProgress,
  streamWikiProgress,
  type AuthUser,
  type BackendRepo,
  type JobProgress,
  type ProductHistoryEntry,
} from '../services/backend-client';
import { WikiPreview } from './WikiPreview';

/** Strip the -YYYYMMDDhhmmss timestamp suffix from a repo name. */
function getProjectBaseName(repoName: string): string {
  return repoName.replace(/-\d{14}$/, '');
}

interface ProjectGroup {
  baseName: string;
  latest: ProductHistoryEntry;
  versions: ProductHistoryEntry[];
}

function groupProjectEntries(entries: ProductHistoryEntry[]): ProjectGroup[] {
  const groups = new Map<string, ProductHistoryEntry[]>();
  for (const entry of entries) {
    const baseName = getProjectBaseName(entry.repoName);
    const group = groups.get(baseName) ?? [];
    group.push(entry);
    groups.set(baseName, group);
  }

  return Array.from(groups.entries()).map(([baseName, versions]) => {
    versions.sort((a, b) => {
      const aTime = a.updatedAt ?? a.importedAt;
      const bTime = b.updatedAt ?? b.importedAt;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });
    return { baseName, latest: versions[0], versions };
  });
}

type ImportMode = 'archive' | 'repository';
type WorkspaceTab = 'intake' | 'history';
type WorkflowStage = 'idle' | 'importing' | 'analyzing' | 'error';
type WikiBgStage = 'idle' | 'running' | 'done' | 'error';

interface ProductWorkbenchProps {
  repos: BackendRepo[];
  serviceConnected: boolean;
  serviceStatusText: string;
  onRetryConnection: () => void | Promise<void>;
  currentUser: AuthUser;
  onLogout: () => void | Promise<void>;
  onOpenRepo: (repoName: string) => void | Promise<void>;
}

const formatDateTime = (value: string): string => {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
};

const SourceBadge = ({
  sourceType,
  branch,
}: {
  sourceType: 'archive' | 'git';
  branch?: string;
}) => {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-deep/70 px-3 py-1 text-[11px] text-text-secondary">
      {sourceType === 'archive' ? <Upload className="h-3 w-3" /> : <GitBranch className="h-3 w-3" />}
      {sourceType === 'archive' ? '压缩包导入' : 'Git 仓库'}
      {branch ? <span className="font-mono text-text-primary">{branch}</span> : null}
    </div>
  );
};

const HistoryCard = ({
  entry,
  onPreview,
  onOpen,
  onDelete,
  previewing,
  active,
  wikiProgress,
}: {
  entry: ProductHistoryEntry;
  onPreview: (repoName: string) => void | Promise<void>;
  onOpen: (repoName: string) => void | Promise<void>;
  onDelete: (entryId: string) => void | Promise<void>;
  previewing: boolean;
  active: boolean;
  wikiProgress?: JobProgress | null;
}) => {
  const [copied, setCopied] = useState(false);
  const [wikiLoading, setWikiLoading] = useState(false);
  const [wikiData, setWikiData] = useState<{ repoName: string; pages: Record<string, string> } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(entry.wikiPassword ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const handleWikiPreview = async () => {
    setWikiLoading(true);
    try {
      const data = await fetchWikiPreview(entry.id);
      setWikiData(data);
    } catch {
      // silently ignore
    } finally {
      setWikiLoading(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(entry.id);
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <>
      {wikiData && (
        <WikiPreview
          repoName={wikiData.repoName}
          pages={wikiData.pages}
          onClose={() => setWikiData(null)}
        />
      )}
      <article
        className={`overflow-hidden rounded-[26px] border transition-all duration-200 ${
          active
            ? 'border-[#79d7be]/40 bg-[linear-gradient(135deg,rgba(121,215,190,0.09),rgba(16,16,24,0.97))] shadow-lg shadow-[#79d7be]/8'
            : 'border-border-subtle bg-surface/95 hover:border-border-default hover:shadow-md hover:shadow-black/20'
        }`}
      >
        <div
          className={`h-[3px] transition-colors duration-200 ${
            active
              ? 'bg-[linear-gradient(90deg,#79d7be_0%,#79d7be50_60%,transparent)]'
              : 'bg-[linear-gradient(90deg,#2a2a3a_0%,transparent)]'
          }`}
        />
        <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-2.5 inline-flex items-center gap-1.5 rounded-md bg-[#79d7be]/10 px-2.5 py-1 text-[10px] font-bold tracking-[0.25em] text-[#79d7be] uppercase ring-1 ring-[#79d7be]/20">
              <History className="h-3 w-3" />
              Imported
            </div>
            <h3 className="font-mono text-sm text-text-primary">{entry.repoName}</h3>
            <p className="mt-2 text-xs leading-6 text-text-secondary">
              {entry.sourceLabel}
              {entry.branch ? ` · ${entry.branch}` : ''}
              {entry.userName ? ` · ${entry.userName}` : ''}
            </p>
          </div>
          <SourceBadge sourceType={entry.sourceType} branch={entry.branch} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => void onPreview(entry.mcpRepoName || entry.repoName)}
            className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border-subtle px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-[#79d7be]/40 hover:text-[#79d7be]"
          >
            {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
            预览图谱
          </button>
          <button
            onClick={() => void onOpen(entry.mcpRepoName || entry.repoName)}
            className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border-subtle px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-[#f3b24c]/40 hover:text-[#f3b24c]"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
            完整查看
          </button>
          {entry.wikiBundlePath ? (
            <button
              onClick={() => void handleWikiPreview()}
              disabled={wikiLoading}
              className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border-subtle px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-[#9cc4ff]/40 hover:text-[#9cc4ff] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {wikiLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookOpen className="h-3.5 w-3.5" />}
              在线预览 Wiki
            </button>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-full border border-border-subtle px-3 py-1.5 text-xs text-text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="flex items-center gap-2">
                Wiki 生成中
                {wikiProgress && wikiProgress.percent > 0 && (
                  <>
                    <span className="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-[#161821]">
                      <span
                        className="block h-full rounded-full bg-[linear-gradient(90deg,#9cc4ff_0%,#79d7be_100%)] transition-[width] duration-300 ease-out"
                        style={{ width: `${Math.min(100, wikiProgress.percent)}%` }}
                      />
                    </span>
                    <span className="tabular-nums">{wikiProgress.percent}%</span>
                  </>
                )}
              </span>
            </span>
          )}
          {confirmingDelete ? (
            <span className="inline-flex items-center gap-1.5">
              <button
                onClick={() => void handleDelete()}
                disabled={deleting}
                className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-red-400/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                确认删除
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border-subtle px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
              >
                取消
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmingDelete(true)}
              className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border-subtle px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-red-400/40 hover:text-red-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </button>
          )}
        </div>

        {entry.wikiBundlePath ? (
          <div className="mt-4 grid gap-3 text-xs text-text-secondary md:grid-cols-2">
            <div className="rounded-2xl bg-deep/80 p-3">
              <div className="mb-1 flex items-center gap-2 text-text-primary">
                <ShieldCheck className="h-3.5 w-3.5 text-[#79d7be]" />
                加密 Wiki 下载
              </div>
              <button
                onClick={() => void downloadEncryptedWiki(entry.id, `${entry.repoName}-wiki.zip`)}
                className="group/enc relative inline-flex cursor-pointer items-center gap-2 text-[#79d7be] transition-colors hover:text-[#9ff0d5]"
                title="下载 AES-256 加密的 Wiki 压缩包。使用 7-Zip、WinRAR 等工具解压时输入下方口令即可。"
              >
                <Download className="h-3.5 w-3.5" />
                下载 Wiki 压缩包
                <span className="pointer-events-none absolute -top-20 left-1/2 z-50 hidden w-56 -translate-x-1/2 rounded-xl border border-border-subtle bg-[#0e0e16] px-3 py-2 text-[11px] leading-relaxed text-text-secondary shadow-lg group-hover/enc:block">
                  下载后使用 7-Zip 或 WinRAR 打开，输入下方解压口令即可查看完整 Wiki 文档。
                </span>
              </button>
            </div>

            <div className="rounded-2xl bg-deep/80 p-3">
              <div className="mb-1 flex items-center gap-2 text-text-primary">
                <Lock className="h-3.5 w-3.5 text-[#f3b24c]" />
                解压口令
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[11px] text-text-secondary">{entry.wikiPassword}</span>
                <button
                  onClick={handleCopy}
                  className="cursor-pointer rounded-full border border-border-subtle px-2 py-1 text-[11px] transition-colors hover:border-[#f3b24c]/40 hover:text-[#f3b24c]"
                >
                  <span className="inline-flex items-center gap-1">
                    <Copy className="h-3 w-3" />
                    {copied ? '已复制' : '复制'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="mt-4 rounded-2xl border border-border-subtle bg-deep/70 p-3 text-xs text-text-secondary">
          <div className="mb-1 flex items-center gap-2 text-text-primary">
            <BookOpen className="h-3.5 w-3.5 text-[#f3b24c]" />
            工作台状态
          </div>
          <p className="leading-6">
            {entry.wikiBundlePath
              ? '该次解析结果已经生成文档包，并可从当前页面预览图谱或进入详情工作台继续查看。'
              : '知识图谱已完成分析，Wiki 文档正在后台生成中，完成后将自动更新本条目。'}
          </p>
        </div>

        <div className="mt-3 text-[11px] text-text-muted">
          {entry.updatedAt
            ? `最近更新：${formatDateTime(entry.updatedAt)} · 首次导入：${formatDateTime(entry.importedAt)}`
            : `完成时间：${formatDateTime(entry.importedAt)}`}
          {entry.previousVersions && entry.previousVersions.length > 0
            ? ` · 历史版本：${entry.previousVersions.length}`
            : ''}
        </div>
        </div>
      </article>
    </>
  );
};

const ProjectGroupCard = ({
  group,
  onPreview,
  onOpen,
  onDelete,
  previewLoadingRepo,
  previewRepoName,
  wikiProgress,
  wikiBgStage,
}: {
  group: ProjectGroup;
  onPreview: (repoName: string) => void | Promise<void>;
  onOpen: (repoName: string) => void | Promise<void>;
  onDelete: (entryId: string) => void | Promise<void>;
  previewLoadingRepo: string | null;
  previewRepoName: string | null;
  wikiProgress: JobProgress | null;
  wikiBgStage: WikiBgStage;
}) => {
  const [showVersions, setShowVersions] = useState(false);
  const [activeVersionIdx, setActiveVersionIdx] = useState(0);
  const activeEntry = group.versions[activeVersionIdx];

  return (
    <div>
      {/* Version management bar */}
      {group.versions.length > 1 && (
        <div className="mb-2 flex items-center justify-between rounded-2xl border border-border-subtle bg-deep/70 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <History className="h-3.5 w-3.5 text-[#9cc4ff]" />
            <span className="font-medium text-text-primary">{group.baseName}</span>
            <span className="rounded-full bg-[#9cc4ff]/15 px-2 py-0.5 text-[10px] text-[#9cc4ff]">
              {group.versions.length} 个版本
            </span>
          </div>
          <button
            onClick={() => setShowVersions((v) => !v)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border-subtle px-3 py-1 text-[11px] text-text-secondary transition-colors hover:border-[#9cc4ff]/40 hover:text-[#9cc4ff]"
          >
            <History className="h-3 w-3" />
            {showVersions ? '收起版本' : '版本管理'}
            {showVersions ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>
      )}

      {/* Version list panel */}
      {showVersions && group.versions.length > 1 && (
        <div className="mb-2 rounded-2xl border border-[#9cc4ff]/20 bg-[#9cc4ff]/5 p-3">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-[#9cc4ff] uppercase">
            版本历史
          </div>
          <div className="grid gap-1.5">
            {group.versions.map((ver, idx) => {
              const ts = ver.updatedAt ?? ver.importedAt;
              return (
                <button
                  key={ver.id}
                  onClick={() => setActiveVersionIdx(idx)}
                  className={`flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-xs transition-all ${
                    idx === activeVersionIdx
                      ? 'border border-[#9cc4ff]/30 bg-[#9cc4ff]/10 text-text-primary'
                      : 'border border-transparent text-text-secondary hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px]">{ver.repoName}</span>
                    {idx === 0 && (
                      <span className="rounded-full bg-[#79d7be]/15 px-1.5 py-0.5 text-[9px] text-[#79d7be]">
                        最新
                      </span>
                    )}
                  </div>
                  <span className="text-text-muted">{formatDateTime(ts)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Show the active version's HistoryCard */}
      <HistoryCard
        entry={activeEntry}
        onPreview={onPreview}
        onOpen={onOpen}
        onDelete={onDelete}
        previewing={previewLoadingRepo === (activeEntry.mcpRepoName || activeEntry.repoName)}
        active={previewRepoName === (activeEntry.mcpRepoName || activeEntry.repoName)}
        wikiProgress={!activeEntry.wikiBundlePath && wikiBgStage === 'running' ? wikiProgress : null}
      />
    </div>
  );
};

export const ProductWorkbench = ({
  repos,
  serviceConnected,
  serviceStatusText,
  onRetryConnection,
  currentUser,
  onLogout,
  onOpenRepo,
}: ProductWorkbenchProps) => {
  const { graph, setGraph, setProjectName, setCurrentRepo, setSelectedNode, setCodePanelOpen } =
    useAppState();

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('intake');
  const [mode, setMode] = useState<ImportMode>('archive');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [repoName, setRepoName] = useState('');
  const [branch, setBranch] = useState('main');
  const [repoCatalog, setRepoCatalog] = useState<BackendRepo[]>(repos);
  const [history, setHistory] = useState<ProductHistoryEntry[]>([]);
  const [workflowStage, setWorkflowStage] = useState<WorkflowStage>('idle');
  const [workflowMessage, setWorkflowMessage] = useState('等待导入任务');
  const [analyzeProgress, setAnalyzeProgress] = useState<JobProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Background wiki job state
  const [wikiBgStage, setWikiBgStage] = useState<WikiBgStage>('idle');
  const [wikiBgProgress, setWikiBgProgress] = useState<JobProgress | null>(null);
  const wikiBgAbortRef = useRef<AbortController | null>(null);
  const [previewRepoName, setPreviewRepoName] = useState<string | null>(null);
  const [previewLoadingRepo, setPreviewLoadingRepo] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [historyScope, setHistoryScope] = useState<'mine' | 'all'>('mine');
  const [adminUsers, setAdminUsers] = useState<AuthUser[]>([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [creatingUser, setCreatingUser] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const HISTORY_COLLAPSED_COUNT = 3;

  const groupedHistory = useMemo(() => groupProjectEntries(history), [history]);

  useEffect(() => {
    setRepoCatalog(repos);
  }, [repos]);

  const refreshHistory = useCallback(async () => {
    const entries = await fetchProductHistory(historyScope).catch(() => [] as ProductHistoryEntry[]);
    setHistory(entries);
    return entries;
  }, [historyScope]);

  const handleDeleteEntry = useCallback(async (entryId: string) => {
    await deleteProductHistory(entryId);
    await refreshHistory();
  }, [refreshHistory]);

  const refreshUsers = useCallback(async () => {
    if (currentUser.role !== 'admin') {
      setAdminUsers([]);
      return [];
    }
    const users = await fetchUsers().catch(() => [] as AuthUser[]);
    setAdminUsers(users);
    return users;
  }, [currentUser.role]);

  const refreshRepos = useCallback(async () => {
    const entries = await fetchRepos().catch(() => [] as BackendRepo[]);
    setRepoCatalog(entries);
    return entries;
  }, []);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    void refreshUsers();
  }, [refreshUsers]);

  const busy = workflowStage !== 'idle' && workflowStage !== 'error';
  const workflowPercent = useMemo(() => {
    if (workflowStage === 'idle') return 0;
    if (workflowStage === 'importing') return mode === 'archive' ? 8 : 10;
    if (workflowStage === 'analyzing') {
      return Math.max(12, Math.min(95, analyzeProgress?.percent ?? 15));
    }
    if (workflowMessage === '处理完成') return 100;
    if (workflowStage === 'error') return Math.max(0, Math.min(95, analyzeProgress?.percent ?? 0));
    return 0;
  }, [analyzeProgress?.percent, mode, workflowMessage, workflowStage]);

  const previewMeta = useMemo(() => {
    if (!previewRepoName) return null;
    const repo = repoCatalog.find((item) => item.name === previewRepoName);
    const latestHistory = history.find(
      (item) => (item.mcpRepoName || item.repoName) === previewRepoName,
    );
    return { repo, latestHistory };
  }, [history, previewRepoName, repoCatalog]);

  const loadRepoPreview = useCallback(
    async (repoToPreview: string) => {
      if (!serviceConnected) {
        setPreviewError('服务未启动，暂时无法加载图谱预览。');
        return;
      }
      setPreviewLoadingRepo(repoToPreview);
      setPreviewError(null);

      try {
        const result = await connectToServer(getBackendUrl(), undefined, undefined, repoToPreview);
        const nextGraph = createKnowledgeGraph();
        for (const node of result.nodes) nextGraph.addNode(node);
        for (const rel of result.relationships) nextGraph.addRelationship(rel);

        setGraph(nextGraph);
        setProjectName(repoToPreview);
        setCurrentRepo(repoToPreview);
        setSelectedNode(null);
        setCodePanelOpen(false);
        setPreviewRepoName(repoToPreview);
      } catch (err) {
        setPreviewError(err instanceof Error ? err.message : '图谱预览加载失败。');
      } finally {
        setPreviewLoadingRepo(null);
      }
    },
    [serviceConnected, setCodePanelOpen, setCurrentRepo, setGraph, setProjectName, setSelectedNode],
  );

  const runAnalyze = useCallback(
    async (repoPath: string): Promise<string> => {
      const { jobId } = await startAnalyze({ path: repoPath, force: true });

      return await new Promise<string>((resolve, reject) => {
        const controller = streamAnalyzeProgress(
          jobId,
          (progress) => {
            setAnalyzeProgress(progress);
            setWorkflowStage('analyzing');
            setWorkflowMessage(progress.message || '解析中');
          },
          (data) => {
            controller.abort();
            setWorkflowMessage('解析完成');
            resolve(data.repoName ?? '');
          },
          (message) => {
            controller.abort();
            reject(new Error(message));
          },
        );
      });
    },
    [],
  );

  const resetWorkflow = () => {
    setWorkflowStage('idle');
    setWorkflowMessage('等待导入任务');
    setAnalyzeProgress(null);
  };

  const handleStart = async () => {
    if (!serviceConnected) {
      setError('服务未启动，请先连接服务后再上传或解析。');
      return;
    }
    if (mode === 'archive' && !selectedFile) {
      setError('请先选择代码压缩包。');
      return;
    }

    if (mode === 'repository' && (!repoName.trim() || !branch.trim())) {
      setError('请填写仓库名和分支。仓库名默认按 GitHub 的 owner/repo 解析。');
      return;
    }

    setError(null);
    setWorkflowStage('importing');
    setWorkflowMessage(mode === 'archive' ? '解压缩中' : '仓库克隆中');
    setAnalyzeProgress(null);

    try {
      const imported =
        mode === 'archive' && selectedFile
          ? await importArchive(selectedFile)
          : await importRepository({
              repoName: repoName.trim(),
              branch: branch.trim(),
            });
      setWorkflowMessage(mode === 'archive' ? '检查代码仓库' : '本地仓库已就绪');

      const actualRepoName = await runAnalyze(imported.repoPath);
      const targetRepoName = actualRepoName || imported.repoName;

      await Promise.all([refreshHistory(), refreshRepos()]);
      await loadRepoPreview(targetRepoName);
      setWorkflowMessage('处理完成');

      resetWorkflow();
      setSelectedFile(null);
      if (mode === 'repository') {
        setRepoName('');
      }

      // Fire wiki generation in background (non-blocking)
      void (async () => {
        try {
          setWikiBgStage('running');
          setWikiBgProgress({ phase: 'queued', percent: 0, message: '启动 Wiki 生成...' });
          const { jobId } = await startWikiAsync({
            repoName: targetRepoName,
            repoPath: imported.repoPath,
            sourceType: mode === 'archive' ? 'archive' : 'git',
            sourceLabel: imported.sourceLabel,
            branch: imported.branch,
          });
          await new Promise<void>((resolve, reject) => {
            const ctrl = streamWikiProgress(
              jobId,
              (progress) => {
                setWikiBgProgress(progress);
              },
              async () => {
                ctrl.abort();
                setWikiBgStage('done');
                setWikiBgProgress(null);
                await refreshHistory();
                resolve();
              },
              (errMsg) => {
                ctrl.abort();
                setWikiBgStage('error');
                setWikiBgProgress({ phase: 'failed', percent: 0, message: errMsg });
                reject(new Error(errMsg));
              },
            );
            wikiBgAbortRef.current = ctrl;
          });
        } catch {
          // Non-fatal — wiki failure doesn't block the main flow
          setWikiBgStage('error');
        }
      })();
    } catch (err) {
      setWorkflowStage('error');
      setAnalyzeProgress(null);
      const message = err instanceof Error ? err.message : '任务执行失败，请查看后端日志。';
      setError(message);
    }
  };

  const tabButtonClass = (tab: WorkspaceTab) =>
    `cursor-pointer rounded-full px-4 py-2 text-sm transition-all ${
      activeTab === tab
        ? 'bg-[#f3b24c] text-[#1b1407]'
        : 'text-text-secondary hover:bg-white/6 hover:text-text-primary'
    }`;

  const handleCreateUser = async () => {
    if (!newUsername.trim() || !newPassword.trim()) {
      setError('新建用户时必须填写用户名和密码。');
      return;
    }
    setCreatingUser(true);
    setError(null);
    try {
      await createUserAccount({
        username: newUsername.trim(),
        password: newPassword.trim(),
        displayName: newDisplayName.trim() || newUsername.trim(),
      });
      setNewUsername('');
      setNewPassword('');
      setNewDisplayName('');
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建用户失败。');
    } finally {
      setCreatingUser(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1520px] flex-col gap-8 px-6 py-8 lg:px-10">
      <section className="relative overflow-hidden rounded-[36px] border border-border-subtle bg-[radial-gradient(circle_at_top_left,rgba(243,178,76,0.16),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(121,215,190,0.14),transparent_30%),linear-gradient(135deg,#101018_0%,#0a0a10_52%,#06060a_100%)] p-8 lg:p-10">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,transparent_0%,rgba(255,255,255,0.02)_45%,transparent_100%)]" />
        <div className="relative grid gap-8 xl:grid-cols-[0.95fr_1.05fr]">
          <div className="flex min-h-[240px] flex-col justify-between">
            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#f3b24c]/25 bg-[#f3b24c]/10 px-4 py-2 text-[11px] font-semibold tracking-[0.28em] text-[#f3b24c] uppercase">
                <User className="h-3.5 w-3.5" />
                {currentUser.displayName}
              </div>
              <div className="rounded-full border border-white/10 px-4 py-2 text-xs text-text-secondary">
                {currentUser.role === 'admin' ? '管理员' : '普通用户'} · {currentUser.username}
              </div>
            </div>

            {currentUser.role === 'admin' && (
              <div className="mt-6 rounded-[24px] border border-white/8 bg-[rgba(8,8,13,0.62)] p-5">
                <div className="mb-4 flex items-center gap-2 text-[11px] tracking-[0.22em] text-text-muted uppercase">
                  <Key className="h-3.5 w-3.5" />
                  用户管理
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <input
                    value={newUsername}
                    onChange={(event) => setNewUsername(event.target.value)}
                    placeholder="用户名"
                    className="rounded-2xl border border-border-subtle bg-surface px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-[#79d7be]/50"
                  />
                  <input
                    value={newDisplayName}
                    onChange={(event) => setNewDisplayName(event.target.value)}
                    placeholder="显示名称"
                    className="rounded-2xl border border-border-subtle bg-surface px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-[#79d7be]/50"
                  />
                  <input
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    placeholder="初始密码"
                    className="rounded-2xl border border-border-subtle bg-surface px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-[#79d7be]/50"
                  />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => void handleCreateUser()}
                    disabled={creatingUser}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-[#79d7be] px-4 py-2 text-xs font-semibold text-[#082018] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {creatingUser ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <User className="h-3.5 w-3.5" />}
                    新增用户
                  </button>
                  <button
                    onClick={() => void refreshUsers()}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border-subtle px-4 py-2 text-xs text-text-secondary transition-colors hover:border-[#f3b24c]/40 hover:text-[#f3b24c]"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    刷新用户
                  </button>
                  <button
                    onClick={() => void onLogout()}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border-subtle px-4 py-2 text-xs text-text-secondary transition-colors hover:border-red-400/40 hover:text-red-300"
                  >
                    退出登录
                  </button>
                </div>
                <div className="mt-4 grid gap-2 md:grid-cols-2">
                  {adminUsers.map((user) => (
                    <div
                      key={user.id}
                      className="rounded-2xl border border-border-subtle bg-surface/80 px-4 py-3 text-sm text-text-secondary"
                    >
                      <div className="text-text-primary">{user.displayName}</div>
                      <div className="mt-1 text-xs">
                        {user.username} · {user.role === 'admin' ? '管理员' : '普通用户'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {currentUser.role !== 'admin' && (
              <div className="mt-6">
                <button
                  onClick={() => void onLogout()}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border-subtle px-4 py-2 text-xs text-text-secondary transition-colors hover:border-red-400/40 hover:text-red-300"
                >
                  退出登录
                </button>
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="overflow-hidden rounded-[28px] border border-white/10 bg-[rgba(8,8,13,0.92)]">
              <div className="h-[3px] bg-[linear-gradient(90deg,#f3b24c_0%,#f3b24c40_65%,transparent)]" />
              <div className="p-5">
                <div className="text-[11px] font-semibold tracking-[0.28em] text-[#f3b24c] uppercase">仓库数</div>
                <div className="mt-2 font-['Bebas_Neue'] text-5xl tracking-[0.06em] text-white">
                  {groupedHistory.length}
                </div>
                <p className="mt-2 text-xs leading-6 text-text-secondary">当前用户解析过的独立仓库数量。</p>
              </div>
            </div>
            <div className="overflow-hidden rounded-[28px] border border-white/10 bg-[rgba(8,8,13,0.92)]">
              <div className="h-[3px] bg-[linear-gradient(90deg,#79d7be_0%,#79d7be40_65%,transparent)]" />
              <div className="p-5">
                <div className="text-[11px] font-semibold tracking-[0.28em] text-[#79d7be] uppercase">历史记录</div>
                <div className="mt-2 font-['Bebas_Neue'] text-5xl tracking-[0.06em] text-white">
                  {history.length}
                </div>
                <p className="mt-2 text-xs leading-6 text-text-secondary">可追踪每次上传、仓库导入与 Wiki 交付。</p>
              </div>
            </div>
            <div className="overflow-hidden rounded-[28px] border border-white/10 bg-[rgba(8,8,13,0.92)]">
              <div className="h-[3px] bg-[linear-gradient(90deg,#9cc4ff_0%,#9cc4ff40_65%,transparent)]" />
              <div className="p-5">
                <div className="text-[11px] font-semibold tracking-[0.28em] text-[#9cc4ff] uppercase">当前状态</div>
                <div className="mt-2 truncate font-mono text-base font-medium text-white">{previewRepoName ?? '未加载图谱'}</div>
                <p className="mt-2 text-xs leading-6 text-text-secondary">
                  {previewRepoName ? '右侧预览区正在展示当前选中的代码图谱。' : '从左侧列表选择一条记录开始预览。'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(380px,0.55fr)_1fr]">
        <div className="space-y-6">
          <div className="rounded-[30px] border border-border-subtle bg-surface/95 p-6">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-[#f3b24c]/20 bg-[#f3b24c]/8 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.25em] text-[#f3b24c] uppercase">
                  <Rocket className="h-3 w-3" />
                  Product Pages
                </div>
                <h2 className="mt-0.5 text-xl font-semibold text-text-primary">上传入口与处理历史</h2>
              </div>
            </div>

            <div className="mb-6 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-[24px] border border-border-subtle bg-deep/70 p-4">
                <div className="mb-3 flex items-center gap-2 text-[11px] tracking-[0.22em] text-text-muted uppercase">
                  <History className="h-3.5 w-3.5" />
                  记录范围
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setHistoryScope('mine')}
                    className={`cursor-pointer rounded-full px-4 py-2 text-xs transition-all ${
                      historyScope === 'mine'
                        ? 'bg-[#f3b24c] text-[#1b1407]'
                        : 'border border-border-subtle text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    我的记录
                  </button>
                  {currentUser.role === 'admin' && (
                    <button
                      onClick={() => setHistoryScope('all')}
                      className={`cursor-pointer rounded-full px-4 py-2 text-xs transition-all ${
                        historyScope === 'all'
                          ? 'bg-[#79d7be] text-[#082018]'
                          : 'border border-border-subtle text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      全部用户记录
                    </button>
                  )}
                </div>
                <p className="mt-3 text-xs leading-6 text-text-secondary">
                  {currentUser.role === 'admin'
                    ? '管理员可以在个人记录和全部记录之间切换。'
                    : '当前仅展示你的个人上传、解析和文档记录。'}
                </p>
              </div>

              <div
                className={`rounded-[24px] border p-4 ${
                  serviceConnected
                    ? 'border-emerald-500/30 bg-emerald-500/8'
                    : 'border-amber-500/30 bg-amber-500/8'
                }`}
              >
                <div className="mb-2 text-[11px] tracking-[0.22em] text-text-muted uppercase">服务状态</div>
                <div className="text-sm text-text-primary">{serviceStatusText}</div>
                <p className="mt-2 text-xs leading-6 text-text-secondary">
                  未连接时你仍可查看页面，但预览图谱、启动解析和进入详情工作台会先进行服务校验。
                </p>
                {!serviceConnected && (
                  <button
                    onClick={() => void onRetryConnection()}
                    className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-full border border-amber-400/30 px-3 py-1.5 text-xs text-amber-200 transition-colors hover:bg-amber-400/10"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    重新检测
                  </button>
                )}
              </div>
            </div>

            <div className="mb-6 grid grid-cols-2 gap-2 rounded-full border border-border-subtle bg-deep p-1">
              <button onClick={() => setActiveTab('intake')} className={tabButtonClass('intake')}>
                新建解析
              </button>
              <button onClick={() => setActiveTab('history')} className={tabButtonClass('history')}>
                历史记录
              </button>
            </div>

            {activeTab === 'intake' ? (
              <div>
                <div className="mb-5 grid grid-cols-2 gap-2 rounded-full border border-border-subtle bg-deep p-1">
                  <button
                    onClick={() => setMode('archive')}
                    className={`cursor-pointer rounded-full px-4 py-2 text-sm transition-all ${
                      mode === 'archive'
                        ? 'bg-[#f3b24c] text-[#1b1407]'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    压缩包上传
                  </button>
                  <button
                    onClick={() => setMode('repository')}
                    className={`cursor-pointer rounded-full px-4 py-2 text-sm transition-all ${
                      mode === 'repository'
                        ? 'bg-[#79d7be] text-[#082018]'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    Git 仓库
                  </button>
                </div>

                {mode === 'archive' ? (
                  <label className="block cursor-pointer rounded-[24px] border border-dashed border-border-default bg-deep/70 p-6 transition-colors hover:border-[#f3b24c]/40">
                    <div className="flex items-center gap-3 text-text-primary">
                      <Upload className="h-4 w-4 text-[#f3b24c]" />
                      选择代码压缩包
                    </div>
                    <p className="mt-3 text-sm leading-6 text-text-secondary">
                      支持 <span className="font-mono text-text-primary">.zip</span>、
                      <span className="font-mono text-text-primary">.tar.gz</span>、
                      <span className="font-mono text-text-primary">.tgz</span>、
                      <span className="font-mono text-text-primary">.tar.bz2</span>、
                      <span className="font-mono text-text-primary">.tar.xz</span> 等格式。
                      上传后会自动解压到本地带时间戳的目录；如果代码里没有初始化 Git，会自动执行 <span className="font-mono">git init</span>。
                    </p>
                    <input
                      type="file"
                      accept=".zip,.tar.gz,.tgz,.tar.bz2,.tbz2,.tar.xz,.txz,.tar,application/zip,application/x-tar,application/gzip,application/x-bzip2,application/x-xz"
                      className="hidden"
                      onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                    />
                    <div className="mt-4 rounded-2xl bg-surface px-4 py-3 font-mono text-xs text-text-secondary">
                      {selectedFile ? selectedFile.name : '尚未选择文件'}
                    </div>
                  </label>
                ) : (
                  <div className="space-y-4">
                    <label className="block">
                      <div className="mb-2 flex items-center gap-2 text-xs tracking-[0.18em] text-text-muted uppercase">
                        <FolderGit2 className="h-3.5 w-3.5" />
                        仓库名
                      </div>
                      <input
                        value={repoName}
                        onChange={(event) => setRepoName(event.target.value)}
                        placeholder="owner/repo"
                        className="w-full rounded-2xl border border-border-subtle bg-deep px-4 py-3 font-mono text-sm text-text-primary outline-none transition-colors focus:border-[#79d7be]/50"
                      />
                    </label>
                    <label className="block">
                      <div className="mb-2 flex items-center gap-2 text-xs tracking-[0.18em] text-text-muted uppercase">
                        <GitBranch className="h-3.5 w-3.5" />
                        分支
                      </div>
                      <input
                        value={branch}
                        onChange={(event) => setBranch(event.target.value)}
                        placeholder="main"
                        className="w-full rounded-2xl border border-border-subtle bg-deep px-4 py-3 font-mono text-sm text-text-primary outline-none transition-colors focus:border-[#79d7be]/50"
                      />
                    </label>
                  </div>
                )}

                <button
                  onClick={handleStart}
                  disabled={busy}
                  className={`mt-6 flex w-full items-center justify-center gap-2 rounded-[24px] px-5 py-4 text-sm font-semibold transition-all ${
                    busy
                      ? 'cursor-not-allowed border border-border-subtle bg-elevated text-text-muted'
                      : 'cursor-pointer bg-[linear-gradient(90deg,#f3b24c_0%,#79d7be_100%)] text-[#101018] shadow-lg shadow-[#f3b24c]/15 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-[#f3b24c]/25'
                  }`}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                  启动解析产品流
                </button>
              </div>
            ) : (
              <div>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-[#79d7be]/20 bg-[#79d7be]/8 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.25em] text-[#79d7be] uppercase">
                      <History className="h-3 w-3" />
                      Delivery History
                    </div>
                    <div className="mt-1 text-sm text-text-secondary">
                      查看上传/仓库导入记录、下载加密中文 Wiki，并回看当前图谱。
                    </div>
                  </div>
                  <button
                    onClick={() => void refreshHistory()}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border-subtle px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-[#79d7be]/40 hover:text-[#79d7be]"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    刷新
                  </button>
                </div>

                <div className="grid gap-4">
                  {history.length === 0 ? (
                    <div className="rounded-[24px] border border-dashed border-border-default bg-deep/70 p-5 text-sm leading-7 text-text-secondary">
                      历史记录会在一次完整解析成功后出现，包含你的上传来源、加密 Wiki 下载链接和解密口令。
                    </div>
                  ) : (
                    <>
                      {(historyExpanded ? groupedHistory : groupedHistory.slice(0, HISTORY_COLLAPSED_COUNT)).map(
                        (group) => (
                          <ProjectGroupCard
                            key={group.baseName}
                            group={group}
                            onPreview={loadRepoPreview}
                            onOpen={onOpenRepo}
                            onDelete={handleDeleteEntry}
                            previewLoadingRepo={previewLoadingRepo}
                            previewRepoName={previewRepoName}
                            wikiProgress={wikiBgProgress}
                            wikiBgStage={wikiBgStage}
                          />
                        ),
                      )}
                      {groupedHistory.length > HISTORY_COLLAPSED_COUNT && (
                        <button
                          onClick={() => setHistoryExpanded((prev) => !prev)}
                          className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-[20px] border border-dashed border-border-default py-3 text-xs text-text-secondary transition-colors hover:border-[#79d7be]/40 hover:text-[#79d7be]"
                        >
                          {historyExpanded ? (
                            <>
                              <ChevronUp className="h-3.5 w-3.5" />
                              收起历史记录
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-3.5 w-3.5" />
                              展开全部 {groupedHistory.length} 个项目
                            </>
                          )}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            <div className="mt-5 rounded-[24px] border border-border-subtle bg-deep/75 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] tracking-[0.18em] text-text-muted uppercase">
                    Workflow Status
                  </div>
                  <div className="mt-1 text-sm text-text-primary">{workflowMessage}</div>
                </div>
                {busy && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#79d7be]" />}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <span
                  className={`rounded-full px-3 py-1 text-xs ${
                    workflowStage === 'importing'
                      ? 'bg-[#f3b24c] text-[#1b1407]'
                      : 'border border-border-subtle text-text-muted'
                  }`}
                >
                  {mode === 'archive' ? '解压缩' : '克隆仓库'}
                </span>
                <span
                  className={`rounded-full px-3 py-1 text-xs ${
                    workflowStage === 'analyzing'
                      ? 'bg-[#79d7be] text-[#082018]'
                      : 'border border-border-subtle text-text-muted'
                  }`}
                >
                  解析中
                </span>
                <span
                  className={`rounded-full px-3 py-1 text-xs ${
                    workflowMessage === '处理完成'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'border border-border-subtle text-text-muted'
                  }`}
                >
                  完成
                </span>
              </div>

              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-muted">
                  <span>当前进度</span>
                  <span>{workflowPercent}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[#161821]">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(90deg,#f3b24c_0%,#79d7be_55%,#9cc4ff_100%)] transition-[width] duration-300 ease-out"
                    style={{ width: `${workflowPercent}%` }}
                  />
                </div>
              </div>

              {error && <p className="mt-4 text-sm leading-6 text-red-400">{error}</p>}
            </div>
          </div>

        </div>
        <div className="rounded-[30px] border border-border-subtle bg-surface/95 p-6">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-[#9cc4ff]/20 bg-[#9cc4ff]/8 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.25em] text-[#9cc4ff] uppercase">
                <Eye className="h-3 w-3" />
                Graph Preview
              </div>
              <h2 className="mt-0.5 text-xl font-semibold text-text-primary">嵌入式图谱预览</h2>
            </div>
            {previewRepoName && (
              <button
                onClick={() => void onOpenRepo(previewRepoName)}
                className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-[#79d7be] px-4 py-2 text-xs font-semibold text-[#082018] shadow-md shadow-[#79d7be]/20 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-[#79d7be]/30"
              >
                <PanelRightClose className="h-3.5 w-3.5" />
                进入完整工作台
              </button>
            )}
          </div>

          <div className="mb-5 grid gap-3 md:grid-cols-3">
            <div className="overflow-hidden rounded-[22px] border border-border-subtle bg-deep/80">
              <div className="h-[2px] bg-[linear-gradient(90deg,#9cc4ff40,transparent)]" />
              <div className="p-4">
                <div className="text-[11px] tracking-[0.18em] text-text-muted uppercase">预览仓库</div>
                <div className="mt-2 truncate font-mono text-sm text-text-primary">{previewRepoName ?? '未选择'}</div>
              </div>
            </div>
            <div className="overflow-hidden rounded-[22px] border border-border-subtle bg-deep/80">
              <div className="h-[2px] bg-[linear-gradient(90deg,#79d7be40,transparent)]" />
              <div className="p-4">
                <div className="text-[11px] tracking-[0.18em] text-text-muted uppercase">节点 / 边</div>
                <div className="mt-2 text-sm text-text-primary">
                  {graph ? `${graph.nodes.length} / ${graph.relationships.length}` : '--'}
                </div>
              </div>
            </div>
            <div className="overflow-hidden rounded-[22px] border border-border-subtle bg-deep/80">
              <div className="h-[2px] bg-[linear-gradient(90deg,#f3b24c40,transparent)]" />
              <div className="p-4">
                <div className="text-[11px] tracking-[0.18em] text-text-muted uppercase">最近交付</div>
                <div className="mt-2 text-sm text-text-primary">
                  {previewMeta?.latestHistory ? formatDateTime(previewMeta.latestHistory.updatedAt ?? previewMeta.latestHistory.importedAt) : '--'}
                </div>
              </div>
            </div>
          </div>

          {previewMeta?.latestHistory && (
            <div className="mb-5 flex flex-wrap gap-2">
              <SourceBadge
                sourceType={previewMeta.latestHistory.sourceType}
                branch={previewMeta.latestHistory.branch}
              />
              <div className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-deep/70 px-3 py-1 text-[11px] text-text-secondary">
                <BookOpen className="h-3 w-3" />
                文档包已生成
              </div>
            </div>
          )}

          {previewError && (
            <div className="mb-4 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {previewError}
            </div>
          )}

          <div className="relative min-h-[720px] overflow-hidden rounded-[28px] border border-border-subtle bg-[linear-gradient(180deg,#0b0b12_0%,#06060a_100%)]">
            {previewLoadingRepo ? (
              <div className="flex h-[720px] items-center justify-center">
                <div className="text-center">
                  <Loader2 className="mx-auto h-8 w-8 animate-spin text-[#79d7be]" />
                  <p className="mt-4 text-sm text-text-secondary">正在加载 {previewLoadingRepo} 的图谱预览...</p>
                </div>
              </div>
            ) : graph && previewRepoName ? (
              <div className="h-[720px]">
                <GraphCanvas compact />
              </div>
            ) : (
              <div className="flex h-[720px] items-center justify-center px-8 text-center">
                <div className="max-w-md">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-[#f3b24c]/25 bg-[#f3b24c]/10">
                    <Eye className="h-7 w-7 text-[#f3b24c]" />
                  </div>
                  <h3 className="text-lg text-text-primary">等待选择一个图谱进行预览</h3>
                  <p className="mt-3 text-sm leading-7 text-text-secondary">
                    你可以从左侧工作台列表或历史记录里点击“预览图谱”，在当前页面直接查看解析结果。
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
