import { Config, Duration, Effect, Layer, Option, Data, Metric, MetricBoundaries, Schedule } from "effect"
import { NodeClusterSocket, NodeRuntime } from "@effect/platform-node"
import { PrismaService } from "@/db/client/effect.ts"
import { PlaceWebsiteScraperWorkflow, PlaceWebsiteScraperWorkflowLayer } from "@/workflows/placeWebsiteScraper/workflow.ts"
import { ClusterWorkflowEngine, RunnerAddress } from "@effect/cluster"
import { PgClient } from "@effect/sql-pg"
import * as fs from "fs/promises"
import { BrowserAgentService } from "@/services/browser.ts"
import { InfraLayer } from "@/infra/services.ts"

export const WorkflowEngineLayer = Layer.unwrapEffect(
    Effect.gen(function* () {
        const url = yield* Config.redacted("PlaceWebsiteScraper_DATABASE_URL")

        return ClusterWorkflowEngine.layer.pipe(
            Layer.provideMerge(
                NodeClusterSocket.layer({
                    shardingConfig: {
                        runnerListenAddress: Option.some(RunnerAddress.make(
                            "0.0.0.0",
                            3040
                        )),
                        runnerAddress: Option.some(RunnerAddress.make(
                            "localhost",
                            3040
                        ))
                    }
                })
            ),
            Layer.provideMerge(
                PgClient.layer({
                    url,
                    connectTimeout: "10 seconds"
                })
            )
        )
    })
)

// Define metrics
const recordsProcessed = Metric.counter("webscraper_records_processed")
const recordsFailed = Metric.counter("webscraper_records_failed")
const recordsTimedOut = Metric.counter("webscraper_records_timed_out")

// Create histogram for processing duration
const processingDuration = Metric.histogram(
    "webscraper_processing_duration_ms",
    MetricBoundaries.linear({ start: 0, width: 10000, count: 10 }) // 0s, 10s, 20s... 100s
)

// Define error for when no more records
class NoMoreRecordsError extends Data.TaggedError("NoMoreRecords")<{}> { }

// Clean up stale browser locks on startup
const cleanupStaleLocks = Effect.gen(function* () {
    yield* Effect.log("🧹 Cleaning up stale browser locks...")

    // Clean up any browser-sessions directories
    yield* Effect.tryPromise({
        try: async () => {
            try {
                const sessions = await fs.readdir('./browser-sessions')
                for (const session of sessions) {
                    try {
                        await fs.rm(`./browser-sessions/${session}`, { recursive: true, force: true })
                        console.log(`✅ Cleaned up session: ${session}`)
                    } catch { }
                }
            } catch { }
        },
        catch: () => new Error("Cleanup failed")
    }).pipe(Effect.catchAll(() => Effect.void))
})

// Fetch next record with retry logic
const fetchNextRecord = Effect.gen(function* () {
    const db = yield* PrismaService;

    yield* Effect.log("🔍 Checking database for next record...")

    const record = yield* db.placeEntry.findFirst({
        where: {
            status: {
                equals: null
            },
        },
        take: 1,
    })

    if (!record) {
        yield* Effect.log("⏸️  No records found, will retry in 30 seconds...")
        return yield* Effect.fail(new NoMoreRecordsError())
    }

    return record
}).pipe(
    Effect.retry(
        Schedule.exponential(Duration.seconds(30)).pipe(
            Schedule.intersect(Schedule.recurs(5)) // Retry 5 times with 30 second intervals
        )
    ),
    Effect.catchTag("NoMoreRecords", () =>
        Effect.gen(function* () {
            yield* Effect.log("⏹️  No more records found after retries, stopping...")
            return null
        })
    )
)

// Process one record
const processOneRecord = Effect.gen(function* () {
    yield* Effect.log("🔄 Starting new iteration")

    const startTime = Date.now()

    const record = yield* fetchNextRecord

    if (!record) {
        return { continue: false } // Signal to stop the loop
    }

    yield* Metric.increment(recordsProcessed)
    yield* Effect.log("✅ Found record to process", { id: record.id, name: record.name })

    yield* Effect.gen(function* () {
        yield* Effect.log("🚀 Starting workflow execution...")

        const isCompleted = yield* PlaceWebsiteScraperWorkflow.execute({
            id: record.id,
            name: record.name,
            url: record.url,
            address: record.address,
            phone: record.telephone,
            location: record.location!,
        }).pipe(
            Effect.timeout(Duration.minutes(5)),
            Effect.map(() => true as boolean | null),
            Effect.catchTag("TimeoutException", () =>
                Effect.gen(function* () {
                    yield* Effect.logWarning("⏱️  Workflow timeout", { id: record.id })
                    yield* Metric.increment(recordsFailed)
                    yield* Metric.increment(recordsTimedOut)
                    return null
                })
            ),
            Effect.catchAll((error) =>
                Effect.gen(function* () {
                    yield* Effect.logError("❌ Workflow error", { id: record.id, error })
                    yield* Metric.increment(recordsFailed)
                    return false as boolean | null
                })
            ),
        )

        yield* Effect.log("🏁 Workflow completed", { id: record.id, isCompleted })

        if (isCompleted !== null) {
            yield* Effect.log("💾 Updating database with result...")
            const db = yield* PrismaService;
            yield* db.placeEntry.update({
                where: { id: record.id },
                data: { status: isCompleted }
            })
            yield* Effect.log("✅ Database updated successfully")
        }

        const duration = Date.now() - startTime
        yield* processingDuration(Effect.succeed(duration))
    }).pipe(
        Effect.catchAll((error) => {
            return Effect.gen(function* () {
                yield* Effect.logError("❌ Error processing record", { id: record.id, error })
                yield* Metric.increment(recordsFailed)

                const duration = Date.now() - startTime
                yield* processingDuration(Effect.succeed(duration))
            })
        })
    )

    yield* Effect.log("✅ Record processed successfully")
    yield* Effect.sleep(Duration.seconds(3)) // Delay before next iteration

    return { continue: true } // Signal to continue the loop
})

// Main processing loop using Effect.loop
const mainProcessingLoop = Effect.loop(
    { continue: true }, // Initial state
    {
        while: (state) => state.continue, // Continue while this is true
        body: () => processOneRecord, // Process one record per iteration
        step: (state) => state // Return the state from processOneRecord
    }
).pipe(
    Effect.andThen(Effect.gen(function* () {
        yield* Effect.log("🎉 All records processed successfully!")
        yield* logMetrics
    }))
)

// Enhanced metrics reporting
const logMetrics = Effect.gen(function* () {
    const processedState = yield* Metric.value(recordsProcessed)
    const failedState = yield* Metric.value(recordsFailed)
    const timedOutState = yield* Metric.value(recordsTimedOut)

    const processed = processedState.count
    const failed = failedState.count
    const timedOut = timedOutState.count

    const successCount = processed - failed
    const successRate = processed > 0
        ? ((successCount / processed) * 100).toFixed(2) + '%'
        : 'N/A'

    yield* Effect.log("📊 ═══════════════════════════════════════")
    yield* Effect.log("📊 WebScraper Metrics Report")
    yield* Effect.log("📊 ═══════════════════════════════════════")
    yield* Effect.log(`📊 Total Processed: ${processed}`)
    yield* Effect.log(`📊 ✅ Succeeded: ${successCount}`)
    yield* Effect.log(`📊 ❌ Failed: ${failed}`)
    yield* Effect.log(`📊 ⏱️  Timed Out: ${timedOut}`)
    yield* Effect.log(`📊 Success Rate: ${successRate}`)
    yield* Effect.log("📊 ═══════════════════════════════════════")
})

// Periodic metrics reporter
const metricsReporter = logMetrics.pipe(
    Effect.repeat(
        Schedule.spaced(Duration.seconds(30))
    ),
    Effect.catchAll((error) =>
        Effect.gen(function* () {
            yield* Effect.logError("Metrics logging error", error)
            return yield* Effect.void
        })
    )
)

// Startup tasks
const startup = Effect.gen(function* () {
    yield* Effect.log("🚀 Starting PlaceWebsiteScraper Runner...")
    yield* cleanupStaleLocks
    yield* Effect.log("✅ Startup checks complete")
})

// Main application
Effect.gen(function* () {
    // Run startup tasks first
    yield* startup

    // Then run the main loop with metrics
    yield* Effect.all([
        mainProcessingLoop,
        metricsReporter
    ], { concurrency: "unbounded" })
}).pipe(
    Effect.scoped,
    Effect.provide(PlaceWebsiteScraperWorkflowLayer),
    Effect.provide(WorkflowEngineLayer),
    Effect.provide(InfraLayer),
    Effect.provide(BrowserAgentService.Default),
    NodeRuntime.runMain
)