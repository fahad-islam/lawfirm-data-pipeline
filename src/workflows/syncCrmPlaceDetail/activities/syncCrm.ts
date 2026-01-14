import { Activity } from "@effect/workflow"
import { Config, Effect, Schedule, Schema } from "effect"
import { SyncCrmplaceDetailWorkflow, SyncCrmplaceDetailWorkflow as Workflow } from "../workflow.ts"
import { PrismaService } from "@/db/client/effect.ts"
import { type BrowserContext, type Page } from "playwright"
import { join } from "node:path"
import { rmSync } from "node:fs"
import { BrowserService } from "@/services/browser.ts"

export class SyncCrmError extends Schema.TaggedError<SyncCrmError>(
    "SyncCrmError"
)("SyncCrmError", {
    message: Schema.String,
    metaData: Schema.optionalWith(Schema.Any, { exact: true })
}) { }

const errorHandler = {
    catch: (error: unknown) => new SyncCrmError({
        message: (error as Error).message,
        metaData: JSON.stringify(error)
    })
}

const sessionPath = './giighire-session'
const lockFile = join(sessionPath, 'SingletonLock')

const cleanupLockFile = Effect.sync(() => {
    try {
        rmSync(lockFile, { force: true });
    } catch (e) {
        // Ignore - file might not exist
    }
});

const withLockFileCleanup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
        cleanupLockFile, // Acquire: clean lock before starting
        () => effect,     // Use: run the effect
        () => cleanupLockFile // Release: clean lock when done
    );


const config: {
    referer?: string;
    timeout?: number;
    waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
} = {
    waitUntil: 'networkidle',
}

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

// Define retry schedules for different types of operations
const navigationRetrySchedule = Schedule.exponential("100 millis").pipe(
    Schedule.intersect(Schedule.recurs(3)) // Retry up to 3 times with exponential backoff
)

export const syncCrm = (
    { payload, executionId }: { payload: typeof Workflow.payloadSchema.Type, executionId: string }
) => {
    return Activity.make({
        name: "ScrapeWebsite",
        error: SyncCrmError,
        execute: withLockFileCleanup(Effect.gen(function* () {
            const attempt = yield* Activity.CurrentAttempt

            const db = yield* PrismaService;
            const browserService = yield* BrowserService;

            yield* Effect.scoped(
                Effect.gen(function* () {
                    const record = yield* db.company.findFirst({
                        where: {
                            id: payload.id
                        },
                        include: {
                            crmSyncEvent: true,
                            servicesOffered: true
                        }
                    }).pipe(
                        Effect.mapError(errorHandler.catch),
                        Effect.tapError((error) => Effect.logError(error.metaData)),
                    )

                    if (!record) return;

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

                    yield* Effect.tryPromise({
                        try: () => page.goto("https://app.giighire.com/my/client/database", config),
                        ...errorHandler
                    }).pipe(
                        Effect.retry(navigationRetrySchedule),
                        Effect.tap(() => Effect.log(`Successfully navigated to ${record.websiteUrl}`))
                    )

                    yield* checkIfAuthNeeded(page)
                    yield* Effect.promise(() => context.storageState({ path: "./playwright/auth.json" }))

                    // Optional: Submit the form
                    let shouldSubmit = yield* fillCreateCompanyForm(page, {
                        address: record.address!,
                        email: record.emailAddress!,
                        industry: record.industry!,
                        location: record.location!,
                        name: record.name,
                        phone: record.phoneNumber!,
                        website: record.websiteUrl,
                        tags: [record.industry!, record.location!, ...new Set(...record.servicesOffered.map((tag) => tag.name))]
                    })


                    if (shouldSubmit) {
                        yield* Effect.log('Submitting form...');
                        yield* Effect.tryPromise({
                            try: () => page.click('#RecruiterClientForm #btnSubmit'),
                            ...errorHandler
                        }).pipe(
                            Effect.tap(() => Effect.log(`Successfully navigated to ${record.websiteUrl}`))
                        )

                        yield* Effect.tryPromise({
                            try: () => page.waitForTimeout(3000),
                            ...errorHandler
                        }).pipe(
                            Effect.retry(navigationRetrySchedule),
                            Effect.tap(() => Effect.log(`Successfully navigated to ${record.websiteUrl}`))
                        )
                    } else {
                        yield* Effect.log("Already exist!")
                    }
                })
            )
        }).pipe(
            Effect.tapError((error) => Effect.logError(`💥 Activity failed with error: ${error}`)),
            Effect.mapError(errorHandler.catch)
        ))
    }).pipe(
        Activity.retry({ times: 3, }),
        SyncCrmplaceDetailWorkflow.withCompensation(
            Effect.fn(function* (value, cause) {
                yield* Effect.logWarning("Compensating activity ScrapeWebsite")
                yield* Effect.logDebug(`Compensation value: ${JSON.stringify(value)}`)
                yield* Effect.logDebug(`Compensation cause: ${cause}`)
            })
        )
    )
}

const checkIfAuthNeeded = (page: Page) => Effect.gen(function* () {
    yield* checkForAuth(page)
    yield* checkForError(page)
})

const checkForAuth = (page: Page) => Effect.gen(function* () {
    const isFacingAuth = yield* Effect.tryPromise({
        try: () => page.locator("#auth-page").count(),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
        Effect.map((num) => num !== 0)
    )

    if (isFacingAuth) yield* performLogin(page)
})

const checkForError = (page: Page) => Effect.gen(function* () {
    const isFacing404 = yield* Effect.tryPromise({
        try: () => page.locator(".error401").count(),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
        Effect.map((num) => num !== 0)
    )

    if (isFacing404) {
        yield* Effect.tryPromise({
            try: () => page.reload(config),
            ...errorHandler
        }).pipe(
            Effect.retry(navigationRetrySchedule),
        )
        yield* performLogin(page)
    }
})

const performLogin = (page: Page) => Effect.gen(function* () {
    const currentUrl = page.url()

    yield* Effect.log({
        currentUrl
    })

    const userEmail = yield* Config.string("GIIGHIRE_EMAIL")
    const userPassword = yield* Config.string("GIIGHIRE_PASSWORD")

    yield* Effect.tryPromise({
        try: () => page.locator('input[name="Email"]').fill(userEmail),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    yield* Effect.tryPromise({
        try: () => page.locator('input[name="Password"]').fill(userPassword),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    yield* Effect.tryPromise({
        try: () => page.locator('div#LoginSubmit').click(),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    yield* Effect.tryPromise({
        try: () => page.waitForTimeout(2000),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    yield* Effect.tryPromise({
        try: () => page.goto(currentUrl, config),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )
})

const companyData = {
    name: "Tech Solutions Inc",
    website: "https://techsolutions.com",
    email: "contact@techsolutions.com",
    phone: "+1234567890",
    industry: "108",
    address: "London",
    location: "",
    tags: [
        "Employment", "Contract Law", "Openennenenenne"
    ]
};

const fillCreateCompanyForm = (page: Page, data: typeof companyData) => Effect.gen(function* () {
    yield* Effect.log('Opening to fill Create Company form...');

    const count = yield* Effect.tryPromise({
        try: () => page.locator("#main-content-area a[href='/my/client/create']").count(),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
        Effect.tap(() => Effect.log(`Successfully navigated to`))
    )

    yield* Effect.log({ count });

    yield* Effect.tryPromise({
        try: () => page.click("#main-content-area a[href='/my/client/create']", config),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
        Effect.tap(() => Effect.log(`Successfully navigated to`))
    )

    yield* Effect.log('Starting to fill Create Company form...');

    yield* Effect.tryPromise({
        try: () => page.waitForSelector('#RecruiterClientForm', config),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    yield* Effect.log('Filling company name...');

    yield* Effect.tryPromise({
        try: () => page.fill('input[name="Name"]', data.name),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    yield* Effect.tryPromise({
        try: () => page.waitForTimeout(10000),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    const errorAlertVisible = yield* Effect.tryPromise({
        try: () => page.locator('#RecruiterClientForm div#ErrorAlert').isVisible(),
        ...errorHandler
    })

    if (errorAlertVisible) {
        return false
    }

    // Fill Website
    if (data.website) {
        yield* Effect.log('Filling website...');

        yield* Effect.tryPromise({
            try: () => page.fill('input[name="Website"]', data.website),
            ...errorHandler
        }).pipe(
            Effect.retry(navigationRetrySchedule),
        )
    }

    // Fill Email
    if (data.email) {
        yield* Effect.log('Filling email...');

        yield* Effect.tryPromise({
            try: () => page.fill('input[name="EmailAddress"]', data.email),
            ...errorHandler
        }).pipe(
            Effect.retry(navigationRetrySchedule),
        )
    }

    // Fill Phone
    if (data.phone) {
        yield* Effect.log('Filling phone...');

        yield* Effect.tryPromise({
            try: () => page.fill('input[name="PhoneNumber"]', data.phone),
            ...errorHandler
        }).pipe(
            Effect.retry(navigationRetrySchedule),
        )
    }

    // Select Industry
    yield* Effect.log('Selecting industry...');

    yield* Effect.tryPromise({
        try: () => page.selectOption('select#IndustrySelect', "108"),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    // Fill Town/City (with autocomplete)
    yield* Effect.log('Filling city...');

    yield* Effect.tryPromise({
        try: () => page.fill('#CompanyCreateAutoCompleteAddress', data.address),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    yield* Effect.tryPromise({
        try: () => page.waitForTimeout(2000),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    yield* Effect.tryPromise({
        try: () => page.keyboard.press('ArrowDown'),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    yield* Effect.tryPromise({
        try: () => page.keyboard.press('Enter'),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    yield* Effect.tryPromise({
        try: () => page.waitForTimeout(6000),
        ...errorHandler
    }).pipe(
        Effect.retry(navigationRetrySchedule),
    )

    // Handle tags (if tag functionality is available)
    if (data.tags && data.tags.length > 0) {
        yield* Effect.log('Adding tags...');
        // Click "Add Tags" button
        yield* Effect.tryPromise({
            try: () => page.click('#AddTagGroup'),
            ...errorHandler
        }).pipe(
            Effect.retry(navigationRetrySchedule),
        )
        yield* Effect.tryPromise({
            try: () => page.waitForTimeout(1000),
            ...errorHandler
        }).pipe(
            Effect.retry(navigationRetrySchedule),
        )

        yield* selectTags(page, data.tags)
    }

    const _errorAlertVisible = yield* Effect.tryPromise({
        try: () => page.locator('#RecruiterClientForm div#ErrorAlert').isVisible(),
        ...errorHandler
    })

    if (_errorAlertVisible) {
        return false
    }

    return true
}).pipe(
    Effect.timeout("2 minutes") // Overall form fill timeout
)


export const selectTags = (page: Page, tags: string[]) =>
    Effect.gen(function* () {
        // Early return if no tags
        if (!tags || tags.length === 0) {
            yield* Effect.log('No tags to select');
            return;
        }

        yield* Effect.log('Adding tags...');

        // Check if tag area is already visible
        const tagAreaVisible = yield* Effect.tryPromise({
            try: () => page.isVisible('#EditTagArea'),
            ...errorHandler
        });

        if (!tagAreaVisible) {
            yield* Effect.log('Tag area not visible, clicking Add Tags button...');

            // Click "Add Tags" button
            yield* Effect.tryPromise({
                try: () => page.click('#AddTagGroup', config),
                ...errorHandler
            }).pipe(
                Effect.retry(navigationRetrySchedule),
                Effect.tap(() => Effect.log`Clicked Add Tags button`)
            );

            yield* Effect.tryPromise({
                try: () => page.waitForTimeout(1000),
                ...errorHandler
            });

            // Wait for tag area to appear
            yield* Effect.tryPromise({
                try: () => page.waitForSelector('#EditTagArea', { timeout: 5000 }),
                ...errorHandler
            }).pipe(
                Effect.retry(navigationRetrySchedule),
                Effect.tap(() => Effect.log`Tag area is now visible`)
            );
        }

        yield* Effect.log({ message: 'Selecting tags', count: tags.length });

        // Select each tag
        for (const tagValue of tags) {
            const element = yield* Effect.tryPromise({
                try: () => page.$(`xpath=//input[@value="${tagValue}"]/parent::label`),
                ...errorHandler
            });

            if (!element) {
                // yield* Effect.tryPromise({
                //     try: () => page.locator('.select2-search__field').fill(tagValue + ", "),
                //     ...errorHandler
                // });
                continue
            }

            yield* Effect.tryPromise({
                try: () => element!.click(),
                ...errorHandler
            });

        }

        // Save tags
        yield* Effect.log('Saving tags...');

        yield* Effect.tryPromise({
            try: () => page.click('#SaveTagUpdate', config),
            ...errorHandler
        }).pipe(
            Effect.retry(navigationRetrySchedule),
            Effect.tap(() => Effect.log`Clicked Save & Close button`)
        );

        yield* Effect.tryPromise({
            try: () => page.waitForTimeout(2000),
            ...errorHandler
        });

        yield* Effect.log`Tags saved successfully`;
    });

