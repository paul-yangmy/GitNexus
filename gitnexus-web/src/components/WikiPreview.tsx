import { useState } from 'react';
import { X, BookOpen, ChevronLeft, FileText, Loader2 } from '@/lib/lucide-icons';
import { MarkdownRenderer } from './MarkdownRenderer';

interface WikiPreviewProps {
  repoName: string;
  pages: Record<string, string>;
  onClose: () => void;
}

const PAGE_LABELS: Record<string, string> = {
  overview: '概览',
  capabilities: '功能簇',
  processes: '执行流程',
  'mcp-service': 'MCP 服务',
};

export const WikiPreview = ({ repoName, pages, onClose }: WikiPreviewProps) => {
  const pageKeys = Object.keys(pages);
  // prefer 'overview' as default, otherwise first page
  const defaultPage = pageKeys.includes('overview') ? 'overview' : (pageKeys[0] ?? '');
  const [activePage, setActivePage] = useState(defaultPage);

  const content = pages[activePage] ?? '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="flex h-[90vh] w-full max-w-6xl overflow-hidden rounded-[28px] border border-border-subtle bg-[#0a0a10] shadow-2xl">
        {/* Sidebar */}
        <aside className="flex w-56 shrink-0 flex-col border-r border-border-subtle bg-[#07070d]">
          <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-4">
            <BookOpen className="h-4 w-4 text-[#f3b24c]" />
            <span className="truncate font-mono text-xs font-semibold text-text-primary">
              {repoName}
            </span>
          </div>
          <nav className="flex-1 overflow-y-auto py-2">
            {pageKeys.map((key) => (
              <button
                key={key}
                onClick={() => setActivePage(key)}
                className={`flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-xs transition-colors ${
                  activePage === key
                    ? 'border-r-2 border-[#f3b24c] bg-[#f3b24c]/10 text-[#f3b24c]'
                    : 'text-text-secondary hover:bg-white/4 hover:text-text-primary'
                }`}
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{PAGE_LABELS[key] ?? key}</span>
              </button>
            ))}
          </nav>
        </aside>

        {/* Content area */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Toolbar */}
          <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>{PAGE_LABELS[activePage] ?? activePage}</span>
            </div>
            <button
              onClick={onClose}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Markdown */}
          <div className="flex-1 overflow-y-auto px-8 py-6">
            {content ? (
              <MarkdownRenderer content={content} />
            ) : (
              <div className="flex h-32 items-center justify-center text-sm text-text-muted">
                暂无内容
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

interface WikiPreviewButtonProps {
  entryId: string;
  onFetch: (entryId: string) => Promise<void>;
  loading: boolean;
}

export const WikiPreviewButton = ({ entryId, onFetch, loading }: WikiPreviewButtonProps) => {
  return (
    <button
      onClick={() => void onFetch(entryId)}
      disabled={loading}
      className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border-subtle px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-[#f3b24c]/40 hover:text-[#f3b24c] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookOpen className="h-3.5 w-3.5" />}
      在线预览 Wiki
    </button>
  );
};
