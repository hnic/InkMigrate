import { invoke } from '@tauri-apps/api/core';

/**
 * 安全调用 Tauri 原生 open_url 命令在系统默认浏览器中打开外部链接。
 * 当不在 Tauri 环境或原生命令失败时，降级使用 window.open。
 */
export async function openExternalUrl(url: string): Promise<void> {
  const trimmed = url?.trim();
  if (!trimmed) return;
  try {
    await invoke('open_url', { url: trimmed });
  } catch (err) {
    console.warn('调用原生 open_url 失败，降级使用 window.open:', err);
    window.open(trimmed, '_blank', 'noopener,noreferrer');
  }
}
