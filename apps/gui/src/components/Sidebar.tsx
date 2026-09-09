import type { PageId } from '../lib/types.js';

interface NavItem {
  id: PageId;
  label: string;
  icon: string;
  step?: number;
}

// 工作流步骤（有序号）
const WORKFLOW: NavItem[] = [
  { id: 'login', label: '登录', icon: '🔑', step: 1 },
  { id: 'scan', label: '扫描', icon: '🔍', step: 2 },
  { id: 'migrate', label: '迁移', icon: '📦', step: 3 },
  { id: 'cleanup', label: '清理', icon: '🗑️', step: 4 },
];

// 工具（无序号）
const TOOLS: NavItem[] = [
  { id: 'report', label: '报告', icon: '📊' },
  { id: 'settings', label: '设置', icon: '⚙️' },
];

export function Sidebar({
  current,
  onSelect,
  sourceAdapter,
}: {
  current: PageId;
  onSelect: (p: PageId) => void;
  /** evernote 文件源无登录/清理步骤，隐藏对应导航项。 */
  sourceAdapter?: 'toutiao' | 'evernote';
}) {
  // evernote 工作流：扫描 → 迁移（无登录、无源端清理），序号重排
  const workflow =
    sourceAdapter === 'evernote'
      ? [
          { id: 'scan' as PageId, label: '扫描预览', icon: '🔍', step: 1 },
          { id: 'migrate' as PageId, label: '迁移', icon: '📦', step: 2 },
        ]
      : WORKFLOW;
  return (
    <nav style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* 工作流步骤 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {workflow.map((item) => (
          <NavButton key={item.id} item={item} current={current} onSelect={onSelect} />
        ))}
      </div>

      {/* 分隔线 */}
      <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />

      {/* 工具 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
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
      style={{
        background: isActive ? 'var(--accent-hover)' : 'transparent',
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
      }}
    >
      {item.step !== undefined && (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '18px',
          height: '18px',
          borderRadius: '50%',
          background: isActive ? 'var(--text)' : 'var(--bg-hover)',
          color: isActive ? 'var(--bg)' : 'var(--text-dim)',
          fontSize: '11px',
          fontWeight: 700,
          flexShrink: 0,
        }}>
          {item.step}
        </span>
      )}
      {item.step === undefined && <span style={{ fontSize: '14px' }}>{item.icon}</span>}
      {item.label}
    </button>
  );
}
