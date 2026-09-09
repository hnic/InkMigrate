import type { CSSProperties } from 'react';
import type { PageId, SourceAdapterKind } from '../lib/types.js';

interface NavItem {
  id: PageId;
  label: string;
  /** 仅工具项渲染 icon；工作流步骤渲染序号徽标（二者互斥）。 */
  icon?: string;
  step?: number;
}

// 工作流步骤（有序号）
const WORKFLOW: NavItem[] = [
  { id: 'login', label: '登录', step: 1 },
  { id: 'scan', label: '扫描', step: 2 },
  { id: 'migrate', label: '迁移', step: 3 },
  { id: 'cleanup', label: '清理', step: 4 },
];

// 工具（无序号）
const TOOLS: NavItem[] = [
  { id: 'report', label: '报告', icon: '📊' },
  { id: 'settings', label: '设置', icon: '⚙️' },
];

// 静态样式提升到模块级，避免每次渲染重建
const navStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '12px' };
const navGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '2px' };
const separatorStyle: CSSProperties = { borderTop: '1px solid var(--border)', margin: '4px 0' };
const navButtonStyle: CSSProperties = {
  textAlign: 'left',
  justifyContent: 'flex-start',
  padding: '8px 10px',
  borderRadius: '6px',
  border: 'none',
  color: 'var(--text)',
  cursor: 'pointer',
  fontSize: '13px',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};
const stepBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '18px',
  height: '18px',
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
  /** evernote 文件源无登录/清理步骤，隐藏对应导航项。
   *  约定：调用方需保证 current 不是被隐藏的页面（App.tsx 已做重定向），
   *  否则导航不会高亮任何项。 */
  sourceAdapter?: SourceAdapterKind;
}) {
  // evernote 工作流：从 WORKFLOW 过滤出扫描/迁移并重排序号（扫描改称「扫描预览」）
  const workflow =
    sourceAdapter === 'evernote'
      ? WORKFLOW.filter((item) => item.id === 'scan' || item.id === 'migrate').map((item, idx) => ({
          ...item,
          label: item.id === 'scan' ? '扫描预览' : item.label,
          step: idx + 1,
        }))
      : WORKFLOW;
  return (
    <nav style={navStyle}>
      {/* 工作流步骤 */}
      <div style={navGroupStyle}>
        {workflow.map((item) => (
          <NavButton key={item.id} item={item} current={current} onSelect={onSelect} />
        ))}
      </div>

      {/* 分隔线 */}
      <div style={separatorStyle} />

      {/* 工具 */}
      <div style={navGroupStyle}>
        {TOOLS.map((item) => (
          <NavButton key={item.id} item={item} current={current} onSelect={onSelect} />
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
        background: isActive ? 'var(--accent-hover)' : 'transparent',
      }}
    >
      {item.step !== undefined && (
        <span style={{
          ...stepBadgeStyle,
          background: isActive ? 'var(--text)' : 'var(--bg-hover)',
          color: isActive ? 'var(--bg)' : 'var(--text-dim)',
        }}>
          {item.step}
        </span>
      )}
      {item.step === undefined && item.icon !== undefined && (
        <span style={{ fontSize: '14px' }}>{item.icon}</span>
      )}
      {item.label}
    </button>
  );
}
