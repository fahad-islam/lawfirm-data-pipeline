import { Config, Data, Duration, Effect, Layer, Metric, MetricBoundaries, Option, Schedule } from "effect"
import { NodeClusterSocket, NodeRuntime } from "@effect/platform-node"
import { PrismaService } from "@/db/client/effect.ts"
import { SyncCrmplaceDetailWorkflow, SyncCrmplaceDetailWorkflowLayer } from "@/workflows/syncCrmPlaceDetail/workflow.ts"
import { ClusterWorkflowEngine, RunnerAddress } from "@effect/cluster"
import { PgClient } from "@effect/sql-pg"
import { BrowserService } from "@/services/browser.ts"
import { InfraLayer } from "@/infra/services.ts"

export const WorkflowEngineLayer = Layer.unwrapEffect(
    Effect.gen(function* () {
        const url = yield* Config.redacted("SyncCrm_DATABASE_URL")

        return ClusterWorkflowEngine.layer.pipe(
            Layer.provideMerge(
                NodeClusterSocket.layer({
                    shardingConfig: {
                        runnerListenAddress: Option.some(RunnerAddress.make(
                            "0.0.0.0",
                            3020
                        )),
                        runnerAddress: Option.some(RunnerAddress.make(
                            "localhost",
                            3020
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

// Define comprehensive metrics
const recordsProcessed = Metric.counter("records_processed")
const recordsFailed = Metric.counter("records_failed")
const recordsSkipped = Metric.counter("records_skipped")
const recordsTimedOut = Metric.counter("records_timed_out")

// Create histogram with boundaries (in milliseconds)
const processingDuration = Metric.histogram(
    "processing_duration_ms",
    MetricBoundaries.linear({ start: 0, width: 1000, count: 10 })
)

// Define error for when no more records
class NoMoreRecordsError extends Data.TaggedError("NoMoreRecords")<{}> { }

// Fetch next record with retry logic
const fetchNextRecord = Effect.gen(function* () {
    const db = yield* PrismaService;

    yield* Effect.log("🔍 Checking database for next record...")

    const record = yield* db.company.findFirst({
        where: {
            crmSyncEvent: null,
            emailAddress: { not: null }
        },
        include: {
            crmSyncEvent: true,
            servicesOffered: true
        }
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
        if (record.servicesOffered.length === 0) {
            yield* Metric.increment(recordsSkipped)
            yield* Effect.log("⏭️  Record has no services, deleting...")

            const db = yield* PrismaService;
            yield* db.company.delete({ where: { id: record.id } })
            yield* db.placeEntry.update({
                where: {
                    name: { equals: record.name },
                    url: record.websiteUrl
                },
                data: { status: null }
            })

            const duration = Date.now() - startTime
            yield* processingDuration(Effect.succeed(duration))
            yield* Effect.log("✅ Skipped record processed")
            return
        }

        yield* Effect.log("🚀 Starting workflow execution...")

        const isCompleted = yield* SyncCrmplaceDetailWorkflow.execute({
            id: record.id,
        }).pipe(
            Effect.timeout(Duration.minutes(3)),
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
            yield* db.company.update({
                where: { id: record.id },
                data: {
                    crmSyncEvent: {
                        create: { status: isCompleted }
                    }
                }
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
    const skippedState = yield* Metric.value(recordsSkipped)
    const timedOutState = yield* Metric.value(recordsTimedOut)

    const processed = processedState.count
    const failed = failedState.count
    const skipped = skippedState.count
    const timedOut = timedOutState.count

    const successCount = processed - failed - skipped
    const successRate = processed > 0
        ? ((successCount / processed) * 100).toFixed(2) + '%'
        : 'N/A'

    yield* Effect.log("📊 ═══════════════════════════════════════")
    yield* Effect.log("📊 Metrics Report")
    yield* Effect.log("📊 ═══════════════════════════════════════")
    yield* Effect.log(`📊 Total Processed: ${processed}`)
    yield* Effect.log(`📊 ✅ Succeeded: ${successCount}`)
    yield* Effect.log(`📊 ❌ Failed: ${failed}`)
    yield* Effect.log(`📊 ⏭️  Skipped (no services): ${skipped}`)
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

// Run both in parallel
const mainWithMetrics = Effect.all([
    mainProcessingLoop,
    metricsReporter
], { concurrency: "unbounded" })

// Start the application
mainWithMetrics.pipe(
    Effect.scoped,
    Effect.provide(SyncCrmplaceDetailWorkflowLayer),
    Effect.provide(WorkflowEngineLayer),
    Effect.provide(InfraLayer),
    Effect.provide(BrowserService.Default),
    NodeRuntime.runMain
)