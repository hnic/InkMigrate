import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  loadConfigFromString,
  type InkMigrateConfig,
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

/**
 * 读取配置文件；仅真正的 ENOENT 返回 undefined（调用方按"无配置"回退），
 * 其他读/解析失败带文件路径重新抛出，避免拼写错误的 --config 静默降级。
 */
function loadConfigFile(configPath: string): InkMigrateConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`读取配置 ${configPath} 失败：${(e as Error).message}`, { cause: e });
  }
  try {
    return loadConfigFromString(raw);
  } catch (e) {
    throw new Error(`解析配置 ${configPath} 失败：${(e as Error).message}`, { cause: e });
  }
}

/** 读取 yaml 中命中的 evernote 来源；未命中返回 undefined（调用方回退 toutiao）。 */
export function resolveEvernoteSource(o: EvernoteSourceOptions): SourceWiring | undefined {
  const configPath = resolve(o.config);
  const cfg = loadConfigFile(configPath);
  if (cfg === undefined) return undefined;
  const src = cfg.sources.find((s) => s.id === o.sourceId);
  if (src === undefined || src.adapter !== 'evernote') return undefined;
  if (!src.enabled) {
    throw new Error(`来源 ${o.sourceId} 在配置中处于 enabled: false 状态，已跳过。`);
  }
  const raw = src.config as Record<string, unknown>;
  const rawPaths: unknown[] = Array.isArray(raw.inputPaths) ? raw.inputPaths : [];
  const inputPaths = rawPaths.map((p) => {
    if (typeof p !== 'string') {
      throw new Error(
        `配置 ${configPath} 中来源 ${o.sourceId} 的 inputPaths 含非字符串项：${JSON.stringify(p)}`,
      );
    }
    return resolve(dirname(configPath), p);
  });
  if (inputPaths.length === 0) {
    throw new Error(`来源 ${o.sourceId} 缺少 inputPaths（ENEX/HTML 导出目录）。`);
  }
  return {
    adapter: createEvernoteSource({ ...raw, sourceInstanceId: src.id, inputPaths }),
    kind: 'evernote',
    // 与 adapter 实际生效的构造参数保持一致（§10.2 config_hash 输入）；
    // 扫描类开关不参与实例指纹，跨机器/移动 stateDir 不影响哈希。
    instanceConfig: { sourceInstanceId: src.id, inputPaths },
  };
}

export interface ToutiaoSourceOptions {
  sourceId: string;
  stateDir: string;
  favoritesUrl?: string;
  maxItems?: number;
}

/**
 * toutiao 浏览器源（含 Profile 存在性校验）。
 * Profile 缺失抛错而非 process.exit：本模块被 CLI 与常驻 engine 共用，
 * 由调用方决定如何上报（CLI 顶层 catch / engine 转 RPC error）。
 */
export function buildToutiaoSource(o: ToutiaoSourceOptions): SourceWiring {
  const profileDir = profilePath(o.stateDir, o.sourceId);
  if (!profileExists(o.stateDir, o.sourceId)) {
    const err = new Error(
      `未找到 Profile：${profileDir}。请先运行：inkmigrate auth login --source ${o.sourceId} --state-dir ${o.stateDir}`,
    );
    (err as Error & { code?: string }).code = 'INKMIGRATE_PROFILE_NOT_FOUND';
    throw err;
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
  const cfg = loadConfigFile(configPath);
  // 配置不存在或完全没有声明 targets → legacy 布局（老用户路径不变）；
  // 声明了 targets 却未命中 → 报错而非静默 legacy：错误布局会写错目录结构，
  // resume 场景下甚至会在项目中途切换布局（数据完整性风险）。
  if (cfg === undefined || cfg.targets.length === 0) return legacyTargetConfig(vaultPath);
  const tgt = cfg.targets.find((t) => t.id === targetId && t.adapter === 'obsidian');
  if (tgt === undefined) {
    const available = cfg.targets.map((t) => t.id).join(', ');
    throw new Error(
      `配置 ${configPath} 中未找到 obsidian 目标 ${targetId}（可用目标：${available}）`,
    );
  }
  if (!tgt.enabled) {
    throw new Error(`目标 ${targetId} 在配置中处于 enabled: false 状态，已跳过。`);
  }
  return ObsidianTargetConfigSchema.parse({
    ...tgt.config,
    vaultPath,
  }) as unknown as Record<string, unknown>;
}
