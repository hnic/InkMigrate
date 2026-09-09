import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  loadConfigFromString,
  type SourceAdapter,
} from '@inkmigrate/core';
import { createToutiaoSource, profileExists, profilePath } from '@inkmigrate/source-toutiao';
import { createEvernoteSource } from '@inkmigrate/source-evernote';
import { ObsidianTargetConfigSchema } from '@inkmigrate/target-obsidian';

/**
 * §10.2 CLI 侧适配器接线（migrate/resume 共用）。
 *
 * - inkmigrate.yaml 命中 `adapter: evernote` 的来源走文件源（ENEX/HTML 导出，
 *   无需浏览器登录）；未命中配置时维持 toutiao 浏览器流程（含 Profile 校验）。
 * - inputPaths 相对配置文件目录解析（§10.2）。
 * - yaml 命中的 obsidian target 经 schema 填默认值（§13.3 目录结构）；
 *   未命中时用 legacy 硬编码，老用户路径不变。
 */

export interface SourceWiring {
  adapter: SourceAdapter;
  /** ensureInstance 用的 adapter kind。 */
  kind: 'evernote' | 'toutiao';
  /** ensureInstance 用的 config（参与 config_hash）。 */
  instanceConfig: Record<string, unknown>;
}

export interface EvernoteSourceOptions {
  config: string;
  sourceId: string;
}

/** 读取 yaml 中命中的 evernote 来源；未命中返回 undefined（调用方回退 toutiao）。 */
export function resolveEvernoteSource(o: EvernoteSourceOptions): SourceWiring | undefined {
  const configPath = resolve(o.config);
  if (!existsSync(configPath)) return undefined;
  const cfg = loadConfigFromString(readFileSync(configPath, 'utf8'));
  const src = cfg.sources.find((s) => s.id === o.sourceId);
  if (src === undefined || src.adapter !== 'evernote') return undefined;
  if (!src.enabled) {
    throw new Error(`来源 ${o.sourceId} 在配置中处于 enabled: false 状态，已跳过。`);
  }
  const raw = src.config as Record<string, unknown>;
  const inputPaths = Array.isArray(raw.inputPaths)
    ? (raw.inputPaths as string[]).map((p) => resolve(dirname(configPath), p))
    : [];
  if (inputPaths.length === 0) {
    throw new Error(`来源 ${o.sourceId} 缺少 inputPaths（ENEX/HTML 导出目录）。`);
  }
  return {
    adapter: createEvernoteSource({ sourceInstanceId: src.id, ...raw, inputPaths }),
    kind: 'evernote',
    instanceConfig: raw,
  };
}

export interface ToutiaoSourceOptions {
  sourceId: string;
  stateDir: string;
  favoritesUrl?: string;
  maxItems?: number;
}

/** toutiao 浏览器源（含 Profile 存在性校验，失败 process.exit(1)）。 */
export function buildToutiaoSource(o: ToutiaoSourceOptions): SourceWiring {
  const profileDir = profilePath(o.stateDir, o.sourceId);
  if (!profileExists(o.stateDir, o.sourceId)) {
    console.error(`未找到 Profile：${profileDir}`);
    console.error(
      `请先运行：inkmigrate auth login --source ${o.sourceId} --state-dir ${o.stateDir}`,
    );
    process.exit(1);
  }
  return {
    adapter: createToutiaoSource({
      sourceInstanceId: o.sourceId,
      profileDir,
      headless: false, // 有头：头条反爬会拦截 headless
      ...(o.favoritesUrl !== undefined ? { favoritesUrl: o.favoritesUrl } : {}),
      ...(o.maxItems !== undefined ? { maxScanItems: o.maxItems } : {}),
    }),
    kind: 'toutiao',
    instanceConfig: {
      sourceInstanceId: o.sourceId,
      profileDir,
      headless: false,
    },
  };
}

/** 组合：yaml evernote 优先，回退 toutiao。 */
export function resolveSourceWiring(
  o: EvernoteSourceOptions & ToutiaoSourceOptions,
): SourceWiring {
  return resolveEvernoteSource(o) ?? buildToutiaoSource(o);
}

/** legacy 目标配置（无 yaml 命中时维持：Vault 根平铺 + Attachments/）。 */
export function legacyTargetConfig(vaultPath: string): Record<string, unknown> {
  return {
    vaultPath,
    importSubdir: '',
    attachmentsSubdir: 'Attachments',
    linkStyle: 'wikilink',
    overwritePolicy: 'preserve',
    collectionMapping: { toTags: false, toFolders: false },
    maxFilenameLength: 100,
  };
}

/** yaml 命中的 obsidian target（schema 默认值）；--vault-path 覆盖 vaultPath。 */
export function resolveTargetConfig(
  config: string,
  targetId: string,
  vaultPath: string,
): Record<string, unknown> {
  const configPath = resolve(config);
  if (existsSync(configPath)) {
    const cfg = loadConfigFromString(readFileSync(configPath, 'utf8'));
    const tgt = cfg.targets.find((t) => t.id === targetId && t.adapter === 'obsidian');
    if (tgt !== undefined) {
      if (!tgt.enabled) {
        throw new Error(`目标 ${targetId} 在配置中处于 enabled: false 状态，已跳过。`);
      }
      return ObsidianTargetConfigSchema.parse({
        ...tgt.config,
        vaultPath,
      }) as unknown as Record<string, unknown>;
    }
  }
  return legacyTargetConfig(vaultPath);
}
