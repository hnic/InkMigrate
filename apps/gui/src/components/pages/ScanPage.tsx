import { useState, useMemo } from 'react';
import type { AppSettings, PageId, ScanStartResult } from '../../lib/types.js';
import { ConfigPrompt } from '../ConfigPrompt.js';
import { normalizeFavoritesUrl, isSendableFavoritesUrl } from '../../lib/favorites-url.js';
import { openExternalUrl } from '../../lib/opener.js';
import { Scan, Square, Search, ExternalLink, Folder, AlertTriangle, ArrowRight, ChevronDown, ChevronUp, FileText } from 'lucide-react';

/** 问题清单最多展示条数（超出截断并提示剩余数量）。 */
const MAX_ISSUES_SHOWN = 5;

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  activePhase: string | null;
  cancel: () => Promise<void>;
  onNavigate?: (page: PageId) => void;
}

export function ScanPage({ settings, update, rpcCall, addLog, activePhase, cancel, onNavigate }: Props) {
  if (settings.sourceAdapter === 'evernote') {
    return <EvernotePreview settings={settings} update={update} rpcCall={rpcCall} addLog={addLog} onNavigate={onNavigate} />;
  }
  return (
    <ToutiaoScan
      settings={settings}
      update={update}
      rpcCall={rpcCall}
      addLog={addLog}
      activePhase={activePhase}
      cancel={cancel}
      onNavigate={onNavigate}
    />
  );
}

/** §15 Evernote 文件源预览：条目数 + 笔记本分布 + 问题清单（不写库）。 */
function EvernotePreview({
  settings,
  update,
  rpcCall,
  addLog,
  onNavigate,
}: Omit<Props, 'activePhase' | 'cancel'>) {
  const [result, setResult] = useState<{
    uniqueItems: number;
    byNotebook: Record<string, number>;
    issues: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handlePreview() {
    setResult(null);
    setError(null);
    setBusy(true);
    try {
      const res = (await rpcCall('scan.preview', {
        source: settings.source,
        stateDir: settings.stateDir,
        configPath: settings.configPath,
      })) as {
        uniqueItems?: number;
        byNotebook?: Record<string, number>;
        issues?: string[];
      };
      setResult({
        uniqueItems: res.uniqueItems ?? 0,
        byNotebook: res.byNotebook ?? {},
        issues: Array.isArray(res.issues) ? res.issues : [],
      });
      addLog('info', `预览完成：${res.uniqueItems ?? 0} 条`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      addLog('error', `预览失败：${msg}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px' }}>扫描预览（Evernote）</h2>

      <ConfigPrompt
        settings={settings}
        update={update}
        required={['stateDir', 'configPath']}
        message="⚠️ 请先在设置页填写工作区目录与配置文件"
      />

      <div style={{ padding: '18px', background: 'var(--bg-panel)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '14px', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
          读取配置指向的 ENEX/HTML 导出文件，统计笔记条目数与笔记本分布。纯本地只读分析，不写入数据库。
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={handlePreview}
            disabled={busy || !settings.stateDir || !settings.configPath}
            className="btn-primary"
            style={{ minWidth: '110px' }}
          >
            <Scan size={15} />
            <span>{busy ? '预览中...' : '开始预览'}</span>
          </button>
        </div>

        {error && (
          <div style={{
            padding: '10px 14px',
            background: 'rgba(239, 68, 68, 0.12)',
            borderRadius: '6px',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            color: 'var(--error)',
            fontSize: '13px',
          }}>
            ❌ {error}
          </div>
        )}

        {result && (
          <div style={{ marginTop: '8px', padding: '16px', background: 'var(--bg-hover)', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: '28px', fontWeight: 700, color: 'var(--success)' }}>
                  {result.uniqueItems}
                </span>
                <span style={{ color: 'var(--text-dim)', fontSize: '13px' }}> 个有效条目</span>
              </div>
              {onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate('migrate')}
                  className="btn-primary btn-sm"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <span>前往迁移</span>
                  <ArrowRight size={13} />
                </button>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <div style={{ fontWeight: 600, fontSize: '12px', color: 'var(--text-dim)', marginBottom: '4px' }}>笔记本分布：</div>
              {Object.entries(result.byNotebook)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([nb, count]) => (
                  <div key={nb} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      <Folder size={14} color="var(--accent)" />
                      <span>{nb}</span>
                    </span>
                    <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>{count} 篇</span>
                  </div>
                ))}
            </div>

            {result.issues.length > 0 && (
              <div style={{ fontSize: '12px', color: 'var(--warning)', whiteSpace: 'pre-wrap', background: 'rgba(245, 158, 11, 0.1)', padding: '10px', borderRadius: '4px' }}>
                ⚠️ {result.issues.length} 条注意事项：
                {'\n'}
                {result.issues.slice(0, MAX_ISSUES_SHOWN).join('\n')}
                {result.issues.length > MAX_ISSUES_SHOWN ? `\n…还有 ${result.issues.length - MAX_ISSUES_SHOWN} 条未显示` : ''}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ToutiaoScan({ settings, update, rpcCall, addLog, activePhase, cancel, onNavigate }: Props) {
  const scanning = activePhase === 'scanning';
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    uniqueItems: number;
    terminationReason: string;
    items: ScanStartResult['items'];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [showItemList, setShowItemList] = useState(false);

  const reasonLabels: Record<string, string> = {
    no_new_items_after_5_cycles: '连续多轮无新内容（已到底）',
    no_load_more: '没有更多内容',
    cancelled: '用户已终止',
  };

  async function handleScan() {
    if (busy || scanning) return;
    const favoritesUrl = normalizeFavoritesUrl(settings.favoritesUrl);
    if (!isSendableFavoritesUrl(favoritesUrl)) {
      const msg = favoritesUrl === ''
        ? '收藏列表 URL 为空，请先在「登录」页登录自动获取，或在下方手动填写'
        : `收藏列表 URL 无法识别（需 http(s) 链接）：「${favoritesUrl}」`;
      setError(msg);
      addLog('error', `扫描失败：${msg}`);
      return;
    }
    if (favoritesUrl !== settings.favoritesUrl) {
      update({ favoritesUrl });
    }
    setResult(null);
    setError(null);
    setBusy(true);
    try {
      const res = (await rpcCall('scan.start', {
        source: settings.source,
        stateDir: settings.stateDir,
        favoritesUrl,
      })) as ScanStartResult;

      setResult({
        uniqueItems: res.uniqueItems ?? 0,
        terminationReason: res.terminationReason ?? '',
        items: Array.isArray(res.items) ? res.items : [],
      });
      addLog('info', `扫描完成：${res.uniqueItems ?? 0} 条`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      addLog('error', `扫描失败：${msg}`);
    } finally {
      setBusy(false);
    }
  }

  type ScanItem = ScanStartResult['items'][number];

  // 过滤展示的条目明细（限制最多渲染前 100 条以确保极速响应，同时保留真实命中总数）
  const { filteredItems, matchCount } = useMemo(() => {
    if (!result?.items) return { filteredItems: [] as ScanItem[], matchCount: 0 };
    const query = searchFilter.trim().toLowerCase();
    const matches = query
      ? result.items.filter((item: ScanItem) => item.title.toLowerCase().includes(query))
      : result.items;
    return {
      filteredItems: matches.slice(0, 100),
      matchCount: matches.length,
    };
  }, [result?.items, searchFilter]);


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px' }}>扫描收藏</h2>

      <ConfigPrompt
        settings={settings}
        update={update}
        required={['stateDir', 'favoritesUrl']}
        message="⚠️ 请先填写工作区目录和收藏列表 URL，并确保已登录"
      />

      <div style={{ padding: '18px', background: 'var(--bg-panel)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '14px', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
          将打开 Chromium 自动化浏览器，加载并滚动解析你的头条收藏列表。扫描结果将安全入库，供后续迁移到 Obsidian。
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={handleScan}
            disabled={busy || scanning || !settings.stateDir || !settings.favoritesUrl || !settings.loggedIn}
            className="btn-primary"
            style={{ minWidth: '110px' }}
          >
            <Scan size={15} />
            <span>{scanning ? '扫描中...' : '开始扫描'}</span>
          </button>
          <button onClick={() => void cancel()} disabled={!scanning} className="btn-danger">
            <Square size={14} />
            <span>终止</span>
          </button>
        </div>

        {settings.stateDir && settings.favoritesUrl && !settings.loggedIn && (
          <div style={{
            padding: '10px 14px',
            background: 'rgba(245, 158, 11, 0.12)',
            borderRadius: '6px',
            border: '1px solid rgba(245, 158, 11, 0.25)',
            fontSize: '13px',
            color: 'var(--warning)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            <AlertTriangle size={16} />
            <span>请先在「登录」页面完成扫码登录，以便扫描你的个人收藏夹。</span>
          </div>
        )}

        {error && (
          <div style={{
            padding: '10px 14px',
            background: 'rgba(239, 68, 68, 0.12)',
            borderRadius: '6px',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            color: 'var(--error)',
            fontSize: '13px',
          }}>
            ❌ {error}
          </div>
        )}

        {result && (
          <div style={{ marginTop: '8px', padding: '16px', background: 'var(--bg-hover)', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
              <div>
                <span style={{ fontSize: '28px', fontWeight: 700, color: 'var(--success)' }}>
                  {result.uniqueItems}
                </span>
                <span style={{ color: 'var(--text-dim)', fontSize: '13px' }}>
                  {' '}个唯一条目 · {reasonLabels[result.terminationReason] ?? result.terminationReason}
                </span>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                {result.items.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowItemList((prev) => !prev)}
                    className="btn-secondary btn-sm"
                  >
                    {showItemList ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    <span>{showItemList ? '收起明细' : '查看条目明细'}</span>
                  </button>
                )}
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate('migrate')}
                    className="btn-primary btn-sm"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                  >
                    <span>前往迁移</span>
                    <ArrowRight size={13} />
                  </button>
                )}
              </div>
            </div>

            {/* 条目明细表格 */}
            {showItemList && result.items.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ position: 'relative', flex: 1 }}>
                    <input
                      value={searchFilter}
                      onChange={(e) => setSearchFilter(e.target.value)}
                      placeholder="搜索文章标题..."
                      style={{ paddingLeft: '30px', fontSize: '12px', height: '32px' }}
                    />
                    <Search size={14} style={{ position: 'absolute', left: '10px', top: '9px', color: 'var(--text-dim)' }} />
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                    {searchFilter.trim()
                      ? `匹配 ${matchCount} 篇${matchCount > 100 ? '（渲染前 100 篇）' : ''} / 共 ${result.items.length} 篇`
                      : result.items.length > 100
                        ? `共 ${result.items.length} 篇（渲染前 100 篇）`
                        : `共 ${result.items.length} 篇`}
                  </span>
                </div>

                <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '4px' }}>
                  {filteredItems.map((item: ScanItem, idx: number) => (
                    <div
                      key={item.externalId ?? idx}
                      style={{
                        padding: '6px 10px',
                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '12px',
                        fontSize: '12px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                        <span className="badge badge-neutral" style={{ fontSize: '10px', padding: '1px 6px' }}>
                          {item.contentKind}
                        </span>
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {item.title || '(无标题)'}
                        </span>
                      </div>
                      <a
                        href={item.canonicalUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: '2px', flexShrink: 0, textDecoration: 'none', cursor: 'pointer' }}
                        title="在系统浏览器中打开原文"
                        onClick={(e) => {
                          e.preventDefault();
                          if (item.canonicalUrl) {
                            void openExternalUrl(item.canonicalUrl);
                          }
                        }}
                      >
                        <ExternalLink size={13} />
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
