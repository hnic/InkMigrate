import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  loadConfigFromString,
  type InkMigrateConfig,
  type SourceAdapter,
} from '@inkmigrate/core';
import { createToutiaoSource, profileExists, profilePath } from '@inkmigrate/source-toutiao';
import {
  createEvernoteSource,
  EvernoteSourceConfigSchema,
  type EvernoteSourceConfig,
} from '@inkmigrate/source-evernote';
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
  /**
   * config 由调用方显式指定（CLI --config / engine params.configPath）时为 true：
   * 文件不存在的 ENOENT 直接抛错而非按"无配置"回退——拼写错误的路径静默
   * 降级到 toutiao 浏览器流程 + legacy 目标布局，正是 resume 中途换布局的
   * 数据完整性风险。默认（走 inkmigrate.yaml 惯例路径）时保持回退。
   */
  explicitConfig?: boolean;
}

/** loadConfigFile 的显式性选项，见 {@link EvernoteSourceOptions.explicitConfig}。 */
interface ExplicitConfigOpts {
  explicit?: boolean;
}

/**
 * 读取配置文件；仅真正的 ENOENT 返回 undefined（调用方按"无配置"回退），
 * 其他读/解析失败带文件路径重新抛出，避免拼写错误的 --config 静默降级。
 */
function loadConfigFile(
  configPath: string,
  opts?: ExplicitConfigOpts,
): InkMigrateConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (opts?.explicit) {
        throw new Error(
          `配置文件不存在：${configPath}（--config 显式指定，不静默回退）`,
          { cause: e },
        );
      }
      return undefined;
    }
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
  const cfg = loadConfigFile(configPath, { explicit: o.explicitConfig });
  if (cfg === undefined) return undefined;
  const src = cfg.sources.find((s) => s.id === o.sourceId);
  // 仅真正未声明该 id 时回退 toutiao 浏览器流程；命中即校验 enabled
  //（原 `adapter !== 'evernote'` 一并短路，enabled:false 的 toutiao 来源被静默放过）
  if (src === undefined) return undefined;
  if (!src.enabled) {
    throw new Error(`来源 ${o.sourceId} 在配置中处于 enabled: false 状态，已跳过。`);
  }
  if (src.adapter !== 'evernote') return undefined;
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
  // schema 填默认值后的完整生效配置：adapter 与 config_hash 用同一对象
  //（§10.2——notebookShortId/stackSeparator/notebookMappings/assets 等行为键变更
  // 可被审计/续跑识别，不再只哈希 {id, inputPaths} 漏掉布局类配置）
  let effective: EvernoteSourceConfig;
  try {
    effective = EvernoteSourceConfigSchema.parse({
      ...raw,
      sourceInstanceId: src.id,
      inputPaths,
    });
  } catch (e) {
    throw new Error(
      `配置 ${configPath} 中来源 ${o.sourceId} 的 config 无效：${(e as Error).message}`,
      { cause: e },
    );
  }
  return {
    adapter: createEvernoteSource(effective),
    kind: 'evernote',
    instanceConfig: effective as unknown as Record<string, unknown>,
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
      // favoritesUrl 决定扫描哪份合集（迁移的数据本身），必须参与 config_hash，
      // 否则换 URL 续跑会复用旧实例指纹；maxScanItems 为测试性截断，不参与
      ...(o.favoritesUrl !== undefined ? { favoritesUrl: o.favoritesUrl } : {}),
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
  opts?: ExplicitConfigOpts,
): Record<string, unknown> {
  const configPath = resolve(config);
  const cfg = loadConfigFile(configPath, opts);
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
