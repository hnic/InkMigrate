import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';

  /**
   * §12.2 浏览器会话配置。Profile 路径由调用方通过 profile.ts 计算后传入。
   */
  export interface BrowserSessionConfig {
    /** 工具专用持久化 Profile 目录（§12.2）。 */
    profileDir: string;
    /**
     * 是否无头模式；默认 false。
     *
     * 【2026-06-27 实测确认】头条【收藏/token 端点】对 headless 做反爬：同一 profile
     * （带 cookie）下，有头拿到 67KB 完整 SPA，headless 仅拿 39 字节空 HTML 骨架。
     * 已排除两个混淆变量：
     *   1. cookie——带 cookie 的 headless 仍 39B；
     *   2. Chromium 指纹——headless + 系统 Chrome（channel:'chrome'）仍 39B。
     * 头条首页在 headless 下可正常访问，拦截只发生在收藏这类高价值端点。Playwright
     * 默认即 new-headless（new-headless 不够隐蔽）。
     * 唯一未测的路径是 stealth（抹 navigator.webdriver 等），但连系统真 Chrome 的
     * headless 都被拦，强烈暗示检测在 headless 运行模式底层而非 JS 指纹层——stealth
     * 成功概率存疑。综上 scan/migrate/cleanup 全部默认有头以保证可用。
     * 复现/对照工具见 scripts/probe-headless-anti-scrape.ts。
     */
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
  /** 在飞的 launch 任务；用于并发 launch 去重与 close 期间的串行化。 */
  private launchPromise: Promise<void> | undefined;

  constructor(private readonly config: BrowserSessionConfig) {}

  async launch(): Promise<void> {
    if (this.context !== undefined) return;
    // 复用在飞的 launch：guard 无法覆盖 await 窗口，并发调用会各起一个浏览器，
    // 第二次赋值覆盖 this.context 后第一个 Chromium 进程就再无句柄可关。
    this.launchPromise ??= (async () => {
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
    })().catch((err: unknown) => {
      // 失败后清除，允许后续 launch() 重试
      this.launchPromise = undefined;
      throw err;
    });
    await this.launchPromise;
  }

  async newPage(): Promise<Page> {
    if (this.context === undefined) {
      throw new Error('ToutiaoBrowserSession not launched; call launch() first');
    }
    return this.context.newPage();
  }

  async close(): Promise<void> {
    // launch 在飞时先等它落定再关闭：否则 close() 看到 context === undefined 直接
    // 返回，随后 launch 完成会把一个全新 context 赋给已经"关闭"的会话（泄漏浏览器）
    if (this.launchPromise !== undefined) {
      await this.launchPromise.catch(() => {
        /* launch 失败则无 context 可关 */
      });
      this.launchPromise = undefined;
    }
    const ctx = this.context;
    this.context = undefined;
    if (ctx !== undefined) {
      // ctx.close() 无超时参数，长时间有头运行后 Chromium 关闭可能卡死
      //（残留页面/渲染进程）。一旦永久挂起，cleanup RPC handler 的 finally 永不返回，
      //前端 busy 永不复位 → 所有按钮灰着点不动。这里给一个上限：超时则放弃等待，
      //让 RPC 尽快释放；浏览器进程由 Playwright/系统最终回收。
      const CLOSE_TIMEOUT_MS = 15_000;
      let timedOut = false;
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<void>((resolve) => {
        timerId = setTimeout(() => {
          timedOut = true;
          resolve();
        }, CLOSE_TIMEOUT_MS);
      });
      try {
        await Promise.race([
          ctx.close({ reason: 'browser-session close timeout' }),
          timer,
        ]).catch((err: unknown) => {
          // close 失败不阻塞（会话即将被丢弃），但记录日志便于排查
          //（如 Windows 上 profile 锁残留、磁盘错误导致的静默浏览器泄漏）
          console.warn('[toutiao-browser-session] context close failed:', err);
        });
      } finally {
        // close 先完成也要清掉定时器：残留 timer 会把 Node 事件循环拖住最多 15s
        clearTimeout(timerId);
      }
      // R16: 超时后 ctx.close() 仍在后台挂起，浏览器进程可能泄漏。
      // Playwright 公开 API 不暴露 browser PID，无法直接 process.kill。
      // 兜底：遍历并强制关闭所有残留 page，触发浏览器释放大部分资源（渲染进程）。
      // 若 ctx 已不可用（已 close）则忽略错误。
      if (timedOut) {
        try {
          const pages = ctx.pages();
          // 不 await：page.close() 走同一条（可能已卡死的）连接，await 会让 close()
          // 远超 CLOSE_TIMEOUT_MS 上限；会话即将被丢弃，触发后不再等待
          void Promise.allSettled(pages.map((p) => p.close({ runBeforeUnload: false })));
        } catch {
          /* ctx 已关闭或不可用，忽略 */
        }
      }
    }
  }

  get launched(): boolean {
    return this.context !== undefined;
  }
}
