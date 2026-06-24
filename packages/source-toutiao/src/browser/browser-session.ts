import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';

/**
 * §12.2 浏览器会话配置。Profile 路径由调用方通过 profile.ts 计算后传入。
 */
export interface BrowserSessionConfig {
  /** 工具专用持久化 Profile 目录（§12.2）。 */
  profileDir: string;
  /** 是否无头模式；auth login 必须 false（用户需要扫码）。默认 false。 */
  headless?: boolean;
  /** 浏览器 locale，默认 zh-CN。 */
  locale?: string;
  /** 时区 ID，默认 Asia/Shanghai。 */
  timezoneId?: string;
  /** 视口大小。 */
  viewport?: { width: number; height: number };
}

/**
 * §12.2 Playwright 持久化浏览器会话管理器。
 *
 * 封装 chromium.launchPersistentContext，提供 launch/newPage/close 生命周期。
 * Profile 位于工具专用目录，与用户日常 Chrome Profile 隔离（§12.2 禁令）。
 *
 * 设计决策：adapter-owned lifecycle。适配器工厂创建本会话实例，
 * prepare() 调用 launch()，close() 调用本类的 close()。
 * 不通过 AdapterContext 传递浏览器句柄（context 形状不可变）。
 */
export class ToutiaoBrowserSession {
  private context: BrowserContext | undefined;

  constructor(private readonly config: BrowserSessionConfig) {}

  async launch(): Promise<void> {
    if (this.context !== undefined) return;
    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: this.config.headless ?? false,
      locale: this.config.locale ?? 'zh-CN',
      timezoneId: this.config.timezoneId ?? 'Asia/Shanghai',
    };
    const viewport = this.config.viewport ?? { width: 1440, height: 1000 };
    launchOptions.viewport = viewport;
    this.context = await chromium.launchPersistentContext(
      this.config.profileDir,
      launchOptions,
    );
  }

  async newPage(): Promise<Page> {
    if (this.context === undefined) {
      throw new Error('ToutiaoBrowserSession not launched; call launch() first');
    }
    return this.context.newPage();
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    if (ctx !== undefined) {
      await ctx.close();
    }
  }

  get launched(): boolean {
    return this.context !== undefined;
  }
}
