import { Activity } from "@effect/workflow"
import { Effect, Schedule, Schema } from "effect"
import { PlacesLocatorWorkflow, PlacesLocatorWorkflow as Workflow } from "../workflow.ts"
import { chromium, type BrowserContext } from "playwright"
import { PrismaService } from "@/db/client/effect.ts"
import { BrowserService } from "@/services/browser.ts"

export class ExtractGooglePlacesError extends Schema.TaggedError<ExtractGooglePlacesError>(
    "ExtractGooglePlacesError"
)("ExtractGooglePlacesError", {
    message: Schema.String,
    metaData: Schema.optionalWith(Schema.Any, { exact: true })
}) { }

const errorHandler = {
    catch: (error: unknown) => new ExtractGooglePlacesError({
        message: (error as Error).message,
        metaData: JSON.stringify(error)
    })
}

const config: {
    referer?: string;
    timeout?: number;
    waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
} = {
    waitUntil: 'networkidle',
}

// Define retry schedules for different types of operations
const navigationRetrySchedule = Schedule.exponential("100 millis").pipe(
    Schedule.intersect(Schedule.recurs(3)) // Retry up to 3 times with exponential backoff
)

const clickRetrySchedule = Schedule.exponential("50 millis").pipe(
    Schedule.intersect(Schedule.recurs(2)) // Retry up to 2 times for clicks
)

const extractionRetrySchedule = Schedule.exponential("200 millis").pipe(
    Schedule.intersect(Schedule.recurs(3)) // Retry up to 3 times for data extraction
)

const scrollRetrySchedule = Schedule.exponential("100 millis").pipe(
    Schedule.intersect(Schedule.recurs(2))
)


const makePage = (context: BrowserContext) => Effect.acquireRelease(
    Effect.tryPromise({
        try: () => context.newPage(),
        ...errorHandler
    }).pipe(
        Effect.timeout("45 seconds"),
        Effect.retry(Schedule.exponential("2 seconds").pipe(
            Schedule.intersect(Schedule.recurs(2))
        )),
        Effect.tap(() => Effect.log("✅ Page opened successfully"))
    ),
    (page) => Effect.tryPromise({
        try: () => page.close(),
        ...errorHandler
    }).pipe(
        Effect.timeout("10 seconds"),
        Effect.catchAll((error) =>
            Effect.logWarning(`⚠️ Page close failed, will force kill: ${error}`)
        )
    )
)

export const extractGooglePlaces = (
    { payload, executionId }: { payload: typeof Workflow.payloadSchema.Type, executionId: string }
) => {
    return Activity.make({
        name: "ExtractGooglePlaces",
        error: ExtractGooglePlacesError,
        execute: Effect.gen(function* () {
            const attempt = yield* Activity.CurrentAttempt

            yield* Effect.log({
                payload,
                executionId,
                attempt
            })

            // const browser = yield* Effect.tryPromise({
            //     try: () => chromium.launch({ headless: false, timeout: 10000000 }),
            //     ...errorHandler
            // }).pipe(
            //     Effect.retry(navigationRetrySchedule),
            //     Effect.tap(() => Effect.log("Browser launched successfully"))
            // )

            // const page = yield* Effect.tryPromise({
            //     try: () => browser.newPage(),
            //     ...errorHandler
            // }).pipe(
            //     Effect.retry(navigationRetrySchedule)
            // )
            const browserService = yield* BrowserService;


            const context = yield* browserService.getContext({
                browserContext: { storageState: "./playwright/auth.json" },
                onBeforeClose: (context) =>
                    Effect.tryPromise({
                        try: () => context.storageState({ path: "./playwright/auth.json" }),
                        catch: (error) => new Error(`Failed to save storage state: ${error}`)
                    }).pipe(Effect.ignore) // Ignore errors to ensure close happens
            })

            yield* Effect.log("DEBUG: Browser handle received")

            // Get the existing page or create a new one
            const page = yield* makePage(context)


            yield* Effect.scoped(
                Effect.gen(function* () {

                    yield* Effect.tryPromise({
                        try: () => page.goto(payload.url, config),
                        ...errorHandler
                    }).pipe(
                        Effect.retry(navigationRetrySchedule),
                        Effect.tap(() => Effect.log(`Successfully navigated to ${payload.url}`))
                    )

                    // Count td elements in a specific tr
                    const maxPages = yield* Effect.tryPromise({
                        try: () => page.locator('tr[jsname="TeSSVd"] td').count(),
                        ...errorHandler
                    }).pipe(
                        Effect.map(counter => counter - 2),
                        Effect.retry(extractionRetrySchedule)
                    )

                    for (let i = 0; i < maxPages; i++) {
                        // Get all clickable business links with retry
                        const businessLinks = yield* Effect.tryPromise({
                            try: () => page.locator('div.VkpGBb').all(),
                            ...errorHandler
                        }).pipe(
                            Effect.retry(extractionRetrySchedule),
                            Effect.tap((links) => Effect.log(`Found ${links.length} business links`))
                        )

                        yield* Effect.log({ page: i + 1, businessCount: businessLinks.length })

                        // Click on each business to reveal details
                        for (const [index, link] of businessLinks.entries()) {
                            // Extract URL with retry
                            const { url: volunerableUrl } = yield* Effect.tryPromise({
                                try: () => link.evaluate((element) => {
                                    const websiteLink = element.querySelector("a.yYlJEf.Q7PwXb.L48Cpd.brKmxb")
                                    const url = websiteLink?.getAttribute('href') || null;
                                    console.log({ url })
                                    return { url } as const
                                }),
                                ...errorHandler
                            }).pipe(
                                Effect.retry(extractionRetrySchedule)
                            )

                            if (volunerableUrl === null) continue

                            let url = yield* Schema.decodeUnknown(Schema.URL)(volunerableUrl).pipe(
                                Effect.mapError(errorHandler.catch),
                                Effect.catchAll(() => Effect.succeed(null)),
                                Effect.map(data => data?.toString())
                            )

                            if (!url) continue

                            const baseElement = link.locator("a.vwVdIc.wzN8Ac.rllt__link")

                            // Click with retry
                            yield* Effect.tryPromise({
                                try: () => baseElement.click(),
                                ...errorHandler
                            }).pipe(
                                Effect.retry(clickRetrySchedule),
                                Effect.tapError((error) =>
                                    Effect.log(`Failed to click business link ${index + 1}: ${error}`)
                                )
                            )

                            // Extract name with retry
                            const { name } = yield* Effect.tryPromise({
                                try: () => baseElement.evaluate((element) => {
                                    // Extract business name
                                    const nameElement = element.querySelector('.rllt__details .OSrXXb');
                                    return { name: nameElement?.textContent?.trim() || null };
                                }),
                                ...errorHandler
                            }).pipe(
                                Effect.retry(extractionRetrySchedule)
                            )

                            // Wait for network idle with retry
                            yield* Effect.tryPromise({
                                try: () => page.waitForLoadState("networkidle"),
                                ...errorHandler
                            }).pipe(
                                Effect.retry(navigationRetrySchedule)
                            )

                            // Timeout - no retry needed for intentional waits
                            yield* Effect.tryPromise({
                                try: () => page.waitForTimeout(5000),
                                ...errorHandler
                            })

                            // Scroll with retry
                            let isScrolled = false;
                            const locatorQueries = ['div[data-attrid="kc:/location/location:address"]', 'div[data-attrid="kc:/local:alt phone"]']

                            for (let locatorQuery of locatorQueries) {
                                const locatorCount = yield* Effect.tryPromise({
                                    try: () => page.locator(locatorQuery)
                                        .count(),
                                    ...errorHandler
                                }).pipe(
                                    Effect.catchAll((error) => {
                                        // If scroll fails after retries, log but continue
                                        return Effect.log(`Could not scroll to address for business ${index + 1}: ${error}`)
                                    })
                                )

                                yield* Effect.log({ locatorCount, locatorQuery })

                                if (locatorCount !== 0) {
                                    isScrolled = true

                                    yield* Effect.tryPromise({
                                        try: () => page.locator(locatorQuery)
                                            .scrollIntoViewIfNeeded({ timeout: 1000000 }),
                                        ...errorHandler
                                    }).pipe(
                                        Effect.retry(scrollRetrySchedule),
                                        Effect.catchAll((error) => {
                                            // If scroll fails after retries, log but continue
                                            return Effect.log(`Could not scroll to address for business ${index + 1}: ${error}`)
                                        })
                                    )
                                }
                            }

                            let address: string | null = null
                            let phone: string | null = null

                            if (isScrolled === true) {
                                // Extract the data from the details panel with retry
                                const businessData = yield* Effect.tryPromise({
                                    try: () => page.evaluate(() => {
                                        // Extract address - look in multiple possible locations
                                        let address = null;
                                        const addressSelector = 'div[data-attrid="kc:/location/location:address"] .LrzXr';

                                        const addressElement = document.querySelector(addressSelector);
                                        if (addressElement?.textContent) {
                                            address = addressElement.textContent.trim();
                                        }

                                        // Extract phone number
                                        let phone = null;
                                        const phoneSelector = 'div[data-attrid="kc:/local:alt phone"] .LrzXr span';

                                        const phoneElement = document.querySelector(phoneSelector);
                                        const phoneText = phoneElement?.textContent?.trim();
                                        // Extract phone number using regex
                                        if (phoneText) {
                                            const phoneMatch = phoneText.match(/(\+?\d[\d\s()-]+)/);
                                            if (phoneMatch && phoneMatch[1]) {
                                                phone = phoneMatch[1].trim();
                                            }
                                        }


                                        return { address, phone };
                                    }),
                                    catch: (error) => new ExtractGooglePlacesError({
                                        message: `Failed to extract business data for item ${index}: ${error}`
                                    })
                                }).pipe(
                                    Effect.catchAll((error) => {
                                        // If extraction fails after retries, return empty data
                                        return Effect.succeed({ address: null, phone: null }).pipe(
                                            Effect.tap(() => Effect.log(`Could not extract data for business ${index + 1}: ${error}`))
                                        )
                                    })
                                )
                                address = businessData.address
                                phone = businessData.phone
                            }
                            if (url !== null && !address?.includes("United States")) {
                                yield* Effect.log({
                                    businessIndex: index + 1,
                                    data: {
                                        name, url, address, phone
                                    }
                                })
                                // Save the info into DB
                                const db = yield* PrismaService

                                yield* db.placeEntry.create({
                                    data: {
                                        name,
                                        url,
                                        address,
                                        telephone: phone,
                                        location: payload.location
                                    }
                                }).pipe(
                                    Effect.mapError(errorHandler.catch),
                                    Effect.tapError((error) => Effect.logError(error.metaData)),
                                    Effect.catchAll(() => Effect.succeedNone)
                                )

                            }
                        }

                        // Check if Next button exists with retry
                        const hasNextButton = yield* Effect.tryPromise({
                            try: () => page.locator('a#pnnext').count(),
                            ...errorHandler
                        }).pipe(
                            Effect.retry(extractionRetrySchedule)
                        )

                        if (hasNextButton > 0 && i < maxPages - 1) {
                            yield* Effect.tryPromise({
                                try: async () => {
                                    const nextUrl = await page.locator('a#pnnext').getAttribute('href')
                                    if (nextUrl) {
                                        await page.goto(`https://www.google.com${nextUrl}`, {
                                            waitUntil: 'networkidle'
                                        })
                                    }
                                },
                                ...errorHandler
                            }).pipe(
                                Effect.retry(navigationRetrySchedule),
                                Effect.tap(() => Effect.log(`Navigated to page ${i + 2}`))
                            )
                        } else {
                            yield* Effect.log("No more pages available")
                            break
                        }
                    }

                })
            )
        }).pipe(
            Effect.tapError((error) => Effect.logError(`💥 Activity failed with error: ${error}`)),
            Effect.mapError(errorHandler.catch)
        )
    }).pipe(
        Activity.retry({ times: 1 }),
        PlacesLocatorWorkflow.withCompensation(
            Effect.fn(function* (value, cause) {
                // This is a compensation finalizer that will be executed if the workflow
                // fails.
                //
                // You can use the success `value` of the wrapped effect, as well as the
                // Cause of the workflow failure.
                yield* Effect.log(`Compensating activity ExtractGooglePlaces`)
            })
        )
    )
}