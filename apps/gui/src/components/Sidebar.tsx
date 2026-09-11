import type { CSSProperties, ReactNode } from 'react';
import type { PageId, SourceAdapterKind } from '../lib/types.js';
import { BarChart3, Settings } from 'lucide-react';

interface NavItem {
  id: PageId;
  label: string;
  icon?: ReactNode;
  step?: number;
}

const WORKFLOW: NavItem[] = [
  { id: 'login', label: '1. 登录认证', step: 1 },
  { id: 'scan', label: '2. 扫描发现', step: 2 },
  { id: 'migrate', label: '3. 导出迁移', step: 3 },
  { id: 'cleanup', label: '4. 源端清理', step: 4 },
];

const TOOLS: NavItem[] = [
  { id: 'report', label: '迁移报告', icon: <BarChart3 size={16} /> },
  { id: 'settings', label: '系统设置', icon: <Settings size={16} /> },
];

const navStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  width: '160px',
};
const navGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' };
const separatorStyle: CSSProperties = { borderTop: '1px solid var(--border)', margin: '4px 0' };

const navButtonStyle: CSSProperties = {
  textAlign: 'left',
  justifyContent: 'flex-start',
  padding: '8px 12px',
  borderRadius: '6px',
  border: '1px solid transparent',
  color: 'var(--text)',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: 500,
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  transition: 'all 0.15s ease',
  width: '100%',
};

const stepBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '20px',
  height: '20px',
  borderRadius: '50%',
  fontSize: '11px',
  fontWeight: 700,
  flexShrink: 0,
};

export function Sidebar({
  current,
  onSelect,
  sourceAdapter,
}: {
  current: PageId;
  onSelect: (p: PageId) => void;
  sourceAdapter?: SourceAdapterKind;
}) {
  const isEvernote = sourceAdapter === 'evernote';

  const workflow: NavItem[] = isEvernote
    ? [
        { id: 'scan', label: '1. 扫描预览', step: 1 },
        { id: 'migrate', label: '2. 导出迁移', step: 2 },
      ]
    : [
        { id: 'login', label: '1. 登录认证', step: 1 },
        { id: 'scan', label: '2. 扫描发现', step: 2 },
        { id: 'migrate', label: '3. 导出迁移', step: 3 },
        { id: 'cleanup', label: '4. 源端清理', step: 4 },
      ];

  const visibleIds = new Set<PageId>([...workflow, ...TOOLS].map((item) => item.id));
  const effectiveCurrent = visibleIds.has(current) ? current : workflow[0].id;

  return (
    <nav style={navStyle} aria-label="主导航">
      <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-dim)', padding: '0 8px', marginBottom: '2px', letterSpacing: '0.5px' }}>
        {isEvernote ? 'EVERNOTE 流程' : '头条迁移流程'}
      </div>

      <div style={navGroupStyle}>
        {workflow.map((item) => (
          <NavButton key={item.id} item={item} current={effectiveCurrent} onSelect={onSelect} />
        ))}
      </div>

      <div style={separatorStyle} />

      <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-dim)', padding: '0 8px', marginBottom: '2px', letterSpacing: '0.5px' }}>
        工具与配置
      </div>

      <div style={navGroupStyle}>
        {TOOLS.map((item) => (
          <NavButton key={item.id} item={item} current={effectiveCurrent} onSelect={onSelect} />
        ))}
      </div>
    </nav>
  );
}

function NavButton({ item, current, onSelect }: { item: NavItem; current: PageId; onSelect: (p: PageId) => void }) {
  const isActive = current === item.id;
  return (
    <button
      onClick={() => onSelect(item.id)}
      aria-current={isActive ? 'page' : undefined}
      style={{
        ...navButtonStyle,
        background: isActive ? 'var(--accent)' : 'transparent',
        color: isActive ? '#ffffff' : 'var(--text)',
        borderColor: isActive ? 'rgba(255,255,255,0.1)' : 'transparent',
      }}
    >
      {item.step !== undefined && (
        <span
          style={{
            ...stepBadgeStyle,
            background: isActive ? 'rgba(255,255,255,0.25)' : 'var(--bg-hover)',
            color: isActive ? '#ffffff' : 'var(--text-dim)',
          }}
        >
          {item.step}
        </span>
      )}
      {item.icon !== undefined && (
        <span style={{ display: 'inline-flex', alignItems: 'center', opacity: isActive ? 1 : 0.8 }}>
          {item.icon}
        </span>
      )}
      <span>{item.label}</span>
    </button>
  );
}
