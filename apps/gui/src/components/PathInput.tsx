import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen, FileSearch, ExternalLink, CheckCircle2, AlertCircle } from 'lucide-react';

interface PathInputProps {
  id?: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  type?: 'directory' | 'file';
  dialogTitle?: string;
  showOpenButton?: boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export function PathInput({
  id,
  value,
  onChange,
  placeholder,
  type = 'directory',
  dialogTitle,
  showOpenButton = true,
  disabled = false,
  style,
}: PathInputProps) {
  const [exists, setExists] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  // 异步检查路径是否存在
  useEffect(() => {
    let active = true;
    const trimmed = value?.trim();
    if (!trimmed) {
      setExists(null);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const ok = (await invoke('check_path_exists', { path: trimmed })) as boolean;
        if (active) setExists(ok);
      } catch {
        if (active) setExists(null);
      }
    }, 250);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [value]);

  const handlePick = useCallback(async () => {
    if (disabled || busy) return;
    setBusy(true);
    try {
      const command = type === 'directory' ? 'pick_directory' : 'pick_file';
      const picked = (await invoke(command, {
        title: dialogTitle ?? (type === 'directory' ? '选择目录' : '选择文件'),
        defaultPath: value?.trim() || undefined,
      })) as string | null;

      if (picked) {
        onChange(picked);
      }
    } catch (err) {
      console.warn('选择路径失败:', err);
    } finally {
      setBusy(false);
    }
  }, [disabled, busy, type, dialogTitle, value, onChange]);

  const handleOpen = useCallback(async () => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    try {
      await invoke('open_in_folder', { path: trimmed });
    } catch (err) {
      console.warn('在文件管理器中打开失败:', err);
    }
  }, [value]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', ...style }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
          <input
            id={id}
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            style={{
              paddingRight: exists !== null ? '30px' : '10px',
              fontFamily: 'inherit',
            }}
          />
          {exists !== null && (
            <span
              title={exists ? '路径有效且存在' : '路径尚未创建或不存在'}
              style={{
                position: 'absolute',
                right: '8px',
                display: 'inline-flex',
                alignItems: 'center',
                pointerEvents: 'none',
                color: exists ? 'var(--success)' : 'var(--warning)',
              }}
            >
              {exists ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={handlePick}
          disabled={disabled || busy}
          className="btn-secondary"
          title={type === 'directory' ? '点击浏览选择文件夹' : '点击浏览选择文件'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            whiteSpace: 'nowrap',
            padding: '7px 12px',
          }}
        >
          {type === 'directory' ? <FolderOpen size={15} /> : <FileSearch size={15} />}
          <span>{type === 'directory' ? '选择目录' : '选择文件'}</span>
        </button>

        {showOpenButton && Boolean(value?.trim()) && exists && (
          <button
            type="button"
            onClick={handleOpen}
            className="btn-ghost"
            title="在系统文件管理器中打开"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '7px 10px',
            }}
          >
            <ExternalLink size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
