import { Config, Effect, Schedule } from "effect";
import type { Scope } from "effect/Scope";
import { BrowserAgent, startBrowserAgent } from "magnitude-core";
import * as playwright from "playwright";
import * as patchright from "patchright";

const executablePath = '/home/fahad/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome'


export class BrowserService extends Effect.Service<BrowserService>()(
    "BrowserService",
    {
        scoped: Effect.gen(function* () {
            // 1. Launch the long-lived Browser process
            const browser = yield* Effect.acquireRelease(
                Effect.promise(() => playwright.chromium.launch({ headless: true, executablePath })),
                (b) => Effect.promise(() => b.close()).pipe(Effect.orDie)
            );

            // 2. Control concurrency (e.g., max 10 contexts at once)
            const semaphore = yield* Effect.makeSemaphore(10);

            return {
                getBrowser: () => browser,
                /**
                 * Returns a fresh, isolated BrowserContext.
                 * Automatically handles cleanup and concurrency gating.
                 * Must be used within Effect.scoped
                 */
                getContext: ({ browserContext, onBeforeClose }: {
                    browserContext?: playwright.BrowserContextOptions,
                    onBeforeClose?: (context: playwright.BrowserContext) => Effect.Effect<void, never, never>
                }) =>
                    semaphore.withPermits(1)(
                        Effect.acquireRelease(
                            Effect.promise(() =>
                                browser.newContext(browserContext)
                            ),
                            (c) =>
                                Effect.gen(function* () {
                                    // ✅ Run the optional callback before closing
                                    if (onBeforeClose) {
                                        yield* onBeforeClose(c);
                                    }
                                    yield* Effect.promise(() => c.close());
                                }).pipe(Effect.orDie)
                        )
                    ).pipe(Effect.retry(Schedule.recurs(2))),
            };
        }),
    }
) { }


export class BrowserAgentService extends Effect.Service<BrowserAgentService>()(
    "BrowserAgentService",
    {
        scoped: Effect.gen(function* () {
            // 1. Launch the long-lived Browser process
            const patchrightBrowser = yield* Effect.promise(() => patchright.chromium.launch({
                headless: true, executablePath, args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage'
                ]
            }))

            // 2. Control concurrency (e.g., max 10 contexts at once)
            const semaphore = yield* Effect.makeSemaphore(10);

            const ApiKey = yield* Config.string("GEMINI_API_KEY")

            return {
                getBrowserAgent: (): Effect.Effect<BrowserAgent, Error, Scope> =>
                    semaphore.withPermits(1)(
                        Effect.acquireRelease(
                            Effect.promise(() =>
                                startBrowserAgent({
                                    narrate: true,
                                    llm: {
                                        provider: "google-ai",
                                        options: {
                                            model: "gemini-2.5-flash-lite",
                                            apiKey: ApiKey,
                                        },
                                    },
                                    browser: {
                                        instance: patchrightBrowser
                                    },
                                })
                            ),
                            (c) =>
                                Effect.promise(() => c.stop()).pipe(Effect.orDie)
                        )
                    ).pipe(Effect.retry(Schedule.recurs(2))),
            };
        }),
    }
) { }