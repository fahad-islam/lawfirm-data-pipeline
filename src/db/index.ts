import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { Config, Effect, Layer, Schedule } from 'effect'
import { PrismaClient } from './client/client.ts'
import { PrismaClientService, PrismaService } from './client/effect.ts'

/**
 * 1. Define the Client Layer
 * We use Layer.scoped so that the PrismaClient can be properly 
 * shut down if the application exits.
 */
const PrismaClientLive = Layer.scoped(
  PrismaClientService,
  Effect.gen(function* () {
    // Effect.config handles the environment variable lookup safely
    const connectionString = yield* Config.string("DATABASE_URL")

    const adapter = new PrismaPg({ connectionString })
    const prisma = new PrismaClient({ adapter })

    // Connect with retry logic
    yield* Effect.tryPromise({
      try: () => prisma.$connect(),
      catch: (error) => new Error(`Failed to connect to database: ${error}`)
    }).pipe(
      Effect.retry(
        Schedule.exponential("1 second").pipe(
          Schedule.intersect(Schedule.recurs(3)) // Retry 3 times
        )
      ),
      Effect.tap(() => Effect.log("Database connected successfully")),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logError("Failed to connect to database after retries", error)
          return yield* Effect.fail(error)
        })
      )
    )

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.log("Disconnecting from database...")
        yield* Effect.tryPromise({
          try: () => prisma.$disconnect(),
          catch: (error) => new Error(`Failed to disconnect from database: ${error}`)
        })
        yield* Effect.log("Database disconnected")
      }).pipe(
        Effect.catchAll((error) =>
          Effect.logError("Error during database disconnect", error)
        )
      )
    )

    return prisma
  })
)

/**
 * 2. Compose the Final Layer
 */
export const DatabaseLive = Layer.provide(
  PrismaService.Default,
  PrismaClientLive
)