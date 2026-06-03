/**
 * routes/browse.ts — 浏览器操作路由
 *
 * POST /browse — 通过 Playwright 操作浏览器。
 * 每次操作自动截图返回，同时 Screencast 帧通过 WebSocket 实时推送。
 */
import type { FastifyInstance } from "fastify";
import { getPage, startScreencast, stopScreencast, takeScreenshot } from "../browser/pool.js";
import { broadcastEvent } from "../events/ws-server.js";
import type { BrowseRequest, BrowseResponse } from "../types.js";

function sanitizeUrlForNavigation(rawUrl: string): string {
  return rawUrl.replace(/[\u0000-\u001f\u007f\s]+/g, "").trim();
}

function isInvalidRedirectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ERR_INVALID_REDIRECT");
}

function resolveFallbackUrlForInvalidRedirect(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.includes("baidu.com") && parsed.pathname === "/link") {
      return "https://www.baidu.com/";
    }
  } catch {
    return null;
  }

  return null;
}

function isExecutionContextDestroyedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Execution context was destroyed");
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Timeout");
}

function isNavigationAbortedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ERR_ABORTED") || message.includes("net::ERR_ABORTED");
}

async function captureScreenshotSafe(
  page: Awaited<ReturnType<typeof getPage>>,
): Promise<string | undefined> {
  try {
    return await takeScreenshot(page);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Browse] 截图失败（忽略）: ${message}`);
    return undefined;
  }
}

async function waitForPageSettledAfterAction(
  page: Awaited<ReturnType<typeof getPage>>,
  timeoutMs: number,
  previousUrl?: string,
): Promise<void> {
  const navigationTimeout = Math.min(timeoutMs, 5_000);

  try {
    await Promise.race([
      page.waitForURL((currentUrl) => currentUrl.toString() !== (previousUrl ?? currentUrl.toString()), {
        timeout: navigationTimeout,
      }),
      page.waitForLoadState("domcontentloaded", { timeout: navigationTimeout }),
      page.waitForTimeout(500),
    ]);
  } catch {
    // 页面不发生导航时，继续走后续稳定等待。
  }

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 2_000 });
  } catch {
    // 某些站点会持续流式更新，忽略该类短超时。
  }

  try {
    await page.waitForLoadState("networkidle", { timeout: 1_500 });
  } catch {
    // 对持续轮询页面不强制要求 networkidle。
  }

  await page.waitForTimeout(200);
}

async function runEvaluateWithRetry<T>(
  page: Awaited<ReturnType<typeof getPage>>,
  runner: () => Promise<T>,
): Promise<T> {
  try {
    return await runner();
  } catch (error) {
    if (!isExecutionContextDestroyedError(error)) {
      throw error;
    }

    await waitForPageSettledAfterAction(page, 3_000, page.url());
    return runner();
  }
}

export async function registerBrowseRoute(app: FastifyInstance) {
  app.post<{ Body: BrowseRequest }>("/browse", async (request): Promise<BrowseResponse> => {
    const { action, url, selector, text, direction, distance, timeout } = request.body;
    const tag = `[Browse]`;

    if (!action) {
      return { success: false, error: "缺少 action 参数" };
    }

    const actionDesc = `${action}${url ? ` url=${url}` : ''}${selector ? ` sel=${selector}` : ''}${text ? ` text="${text.slice(0, 30)}"` : ''}`;
    console.log(`${tag} 开始 | ${actionDesc} | timeout=${timeout ?? 'default'}`);
    const t0 = Date.now();

    // 通知状态
    broadcastEvent({ type: "status", state: "busy", operation: `browse:${action}` });

    try {
      const page = await getPage();

      // 首次操作时启动 Screencast
      await startScreencast(page);

      switch (action) {
        // 导航到指定 URL
        case "goto": {
          if (!url) return { success: false, error: "goto 需要 url 参数" };
          const gotoTimeout = timeout ?? 30_000;
          const normalizedUrl = sanitizeUrlForNavigation(url);
          console.log(`${tag} [goto] 导航中... | url=${normalizedUrl} | timeout=${gotoTimeout}ms`);
          try {
            await page.goto(normalizedUrl, {
              waitUntil: "domcontentloaded",
              timeout: gotoTimeout,
            });
          } catch (error) {
            if (isInvalidRedirectError(error)) {
              const fallbackUrl = resolveFallbackUrlForInvalidRedirect(normalizedUrl);
              if (fallbackUrl) {
                console.warn(`${tag} [goto] 发现无效跳转，改为兜底地址: ${fallbackUrl}`);
                await page.goto(fallbackUrl, {
                  waitUntil: "domcontentloaded",
                  timeout: gotoTimeout,
                });
              } else {
                throw error;
              }
            } else if (isNavigationAbortedError(error)) {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(`${tag} [goto] 导航被目标站中止，继续读取当前页面: ${message}`);
            } else if (isTimeoutError(error)) {
              // 某些站点会持续加载资源，允许超时后继续读取当前页面状态。
              const message = error instanceof Error ? error.message : String(error);
              console.warn(`${tag} [goto] 导航超时，继续返回当前页面信息: ${message}`);
            } else {
              throw error;
            }
          }

          await waitForPageSettledAfterAction(page, 3_000, normalizedUrl).catch(() => undefined);

          const screenshot = await captureScreenshotSafe(page);
          const title = await page.title();
          console.log(`${tag} [goto] 完成 | ${Date.now() - t0}ms | title=${title} | url=${page.url()}`);
          broadcastEvent({ type: "navigate", url: page.url(), title });
          broadcastEvent({ type: "status", state: "idle" });
          return {
            success: true,
            data: { title, url: page.url(), ...(screenshot ? { screenshot } : {}) },
          };
        }

        // 点击元素
        case "click": {
          if (!selector) return { success: false, error: "click 需要 selector 参数" };
          const clickTimeout = timeout ?? 10_000;
          console.log(`${tag} [click] 点击 ${selector} | timeout=${clickTimeout}ms`);
          const previousUrl = page.url();
          await page.click(selector, { timeout: clickTimeout });
          await waitForPageSettledAfterAction(page, clickTimeout, previousUrl);
          const screenshot = await captureScreenshotSafe(page);
          console.log(`${tag} [click] 完成 | ${Date.now() - t0}ms`);
          broadcastEvent({ type: "status", state: "idle" });
          return {
            success: true,
            data: { title: await page.title(), url: page.url(), ...(screenshot ? { screenshot } : {}) },
          };
        }

        // 输入文字
        case "type": {
          if (!selector || !text) return { success: false, error: "type 需要 selector 和 text 参数" };
          const typeTimeout = timeout ?? 10_000;
          console.log(`${tag} [type] 在 ${selector} 输入 "${text.slice(0, 30)}" | timeout=${typeTimeout}ms`);
          await page.fill(selector, text, { timeout: typeTimeout });
          const screenshot = await captureScreenshotSafe(page);
          console.log(`${tag} [type] 完成 | ${Date.now() - t0}ms`);
          broadcastEvent({ type: "status", state: "idle" });
          return {
            success: true,
            data: { title: await page.title(), url: page.url(), ...(screenshot ? { screenshot } : {}) },
          };
        }

        // 页面滚动
        case "scroll": {
          const dir = direction ?? "down";
          const dist = distance ?? 500;
          console.log(`${tag} [scroll] ${dir} ${dist}px`);
          await runEvaluateWithRetry(page, () =>
            page.evaluate(`window.scrollBy(0, ${dir === "down" ? dist : -dist})`),
          );
          await page.waitForTimeout(300);
          const screenshot = await captureScreenshotSafe(page);
          console.log(`${tag} [scroll] 完成 | ${Date.now() - t0}ms`);
          broadcastEvent({ type: "status", state: "idle" });
          return {
            success: true,
            data: { title: await page.title(), url: page.url(), ...(screenshot ? { screenshot } : {}) },
          };
        }

        // 截图
        case "screenshot": {
          console.log(`${tag} [screenshot] 截图中...`);
          const screenshot = await captureScreenshotSafe(page);
          if (!screenshot) {
            return { success: false, error: "截图失败，请稍后重试" };
          }
          console.log(`${tag} [screenshot] 完成 | ${Date.now() - t0}ms`);
          broadcastEvent({ type: "status", state: "idle" });
          return {
            success: true,
            data: { title: await page.title(), url: page.url(), screenshot },
          };
        }

        // 检查页面可交互元素
        case "inspect": {
          console.log(`${tag} [inspect] 扫描可交互元素...`);
          const elements = await runEvaluateWithRetry(page, () =>
            page.evaluate(`
              (() => {
                const seen = new Set();
                const els = document.querySelectorAll(
                  'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [onclick], [tabindex="0"], label'
                );
                const results = [];
                for (const el of els) {
                  if (results.length >= 60) break;
                  const rect = el.getBoundingClientRect();
                  if (rect.width === 0 && rect.height === 0) continue;
                  const tag = el.tagName.toLowerCase();
                  const id = el.id || undefined;
                  const cls = el.className?.toString?.()?.trim()?.slice(0, 80) || undefined;
                  const text = el.textContent?.trim()?.slice(0, 60) || undefined;
                  const type = el.getAttribute('type') || undefined;
                  const placeholder = el.getAttribute('placeholder') || undefined;
                  const href = tag === 'a' ? el.getAttribute('href')?.slice(0, 100) : undefined;
                  let selector = '';
                  if (id) {
                    selector = '#' + id;
                  } else if (cls) {
                    const firstClass = cls.split(/\\s+/)[0];
                    selector = tag + '.' + firstClass;
                  } else if (text && text.length < 30) {
                    selector = tag + ':has-text("' + text.slice(0, 25) + '")';
                  } else {
                    selector = tag;
                  }
                  const key = selector + '|' + (text || '');
                  if (seen.has(key)) continue;
                  seen.add(key);
                  results.push({ tag, id, class: cls, text, type, placeholder, href, selector });
                }
                return results;
              })()
            `),
          );
          console.log(`${tag} [inspect] 完成 | ${Date.now() - t0}ms | 元素数=${(elements as unknown[]).length}`);
          broadcastEvent({ type: "status", state: "idle" });
          return {
            success: true,
            data: {
              title: await page.title(),
              url: page.url(),
              elements: elements as BrowseResponse["data"] extends { elements?: infer E } ? E : never,
            },
          };
        }

        // 提取页面文本内容
        case "content": {
          console.log(`${tag} [content] 提取页面文本...`);
          const content = await runEvaluateWithRetry(page, () =>
            page.evaluate(() => {
              const doc = (globalThis as any).document;
              const clone = doc.cloneNode(true);
              clone.querySelectorAll("script, style, nav, footer, header, aside").forEach((el: any) => el.remove());
              const main = clone.querySelector("article, main, [role='main'], .content");
              const text = (main || clone.body || {}).textContent || "";
              return text.replace(/\s{3,}/g, "\n\n").trim().slice(0, 8000);
            }),
          );
          console.log(`${tag} [content] 完成 | ${Date.now() - t0}ms | 文本长度=${(content as string).length}`);
          broadcastEvent({ type: "status", state: "idle" });
          return {
            success: true,
            data: { title: await page.title(), url: page.url(), content: content as string },
          };
        }

        default:
          console.warn(`${tag} 未知操作: ${action}`);
          broadcastEvent({ type: "status", state: "idle" });
          return { success: false, error: `未知操作: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const elapsed = Date.now() - t0;
      console.error(`${tag} 异常 | ${action} | ${elapsed}ms | ${msg}`);
      broadcastEvent({ type: "error", message: msg });
      broadcastEvent({ type: "status", state: "idle" });

      // 超时错误附带当前页面信息和可交互元素，帮助 LLM 修正选择器
      let extra: Record<string, unknown> = {};
      if (msg.includes("Timeout")) {
        try {
          const page = await getPage();
          extra.currentUrl = page.url();
          extra.currentTitle = await page.title();
          // 附带可交互元素列表，帮助 LLM 找到正确选择器
          const nearbyElements = await page.evaluate(`
            (() => {
              const els = document.querySelectorAll(
                'a[href], button, input, textarea, select, [role="button"], [onclick]'
              );
              return [...els].slice(0, 30).map(el => {
                const tag = el.tagName.toLowerCase();
                const id = el.id || undefined;
                const cls = el.className?.toString?.()?.trim()?.slice(0, 60) || undefined;
                const text = el.textContent?.trim()?.slice(0, 40) || undefined;
                let sel = id ? '#' + id : (cls ? tag + '.' + cls.split(/\\s+/)[0] : tag);
                return { tag, id, text, selector: sel };
              });
            })()
          `);
          extra.availableElements = nearbyElements;
        } catch { /* 忽略 */ }
      }
      return { success: false, error: msg, ...extra };
    } finally {
      await stopScreencast();
    }
  });
}
