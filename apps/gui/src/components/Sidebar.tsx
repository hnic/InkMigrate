import type { PageId } from '../lib/types.js';

const PAGES: { id: PageId; label: string; icon: string }[] = [
  { id: 'login', label: '登录', icon: '🔑' },
  { id: 'scan', label: '扫描', icon: '🔍' },
  { id: 'migrate', label: '迁移', icon: '📦' },
  { id: 'cleanup', label: '清理', icon: '🗑️' },
  { id: 'report', label: '报告', icon: '📊' },
  { id: 'settings', label: '设置', icon: '⚙️' },
];

export function Sidebar({ current, onSelect }: { current: PageId; onSelect: (p: PageId) => void }) {
  return (
    <nav style={{ width: '160px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {PAGES.map((page) => (
        <button
          key={page.id}
          onClick={() => onSelect(page.id)}
          style={{
            background: current === page.id ? 'var(--accent-hover)' : 'transparent',
            textAlign: 'left',
            justifyContent: 'flex-start',
            padding: '10px 12px',
            borderRadius: '8px',
            border: 'none',
            color: 'var(--text)',
            cursor: 'pointer',
            fontSize: '14px',
          }}
        >
          {page.icon} {page.label}
        </button>
      ))}
    </nav>
  );
}
