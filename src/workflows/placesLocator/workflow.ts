import { Workflow } from "@effect/workflow";
import { Effect, Schema } from "effect";
import { ExtractGooglePlacesError, extractGooglePlaces } from "./activities/index.ts";

export const PlacesLocatorWorkflow = Workflow.make({
    name: "PlacesLocatorWorkflow",

    success: Schema.Void,
    error: ExtractGooglePlacesError,
    payload: {
        id: Schema.String,
        url: Schema.String,
        location: Schema.String,
    },

    idempotencyKey: ({ id }) => id,
})

export const PlacesLocatorWorkflowLayer = PlacesLocatorWorkflow.toLayer(
    Effect.fn(function* (payload, executionId) {
        yield* Effect.log("Waiting...")
        yield* extractGooglePlaces({ payload, executionId })
        yield* Effect.log("Completed...")
        yield* Effect.log("Done...")
    })
)

// const updateStatusOfWorkflow = (executionId: string) => Effect.gen(function* () {
//     const db = yield* PrismaService

//     yield* db.googlePlaceUrlToScrape.update({
//         where: {
//             id: executionId
//         },
//         data: {
//             status: true,
//         }
//     })
// }).pipe(
//     Effect.provide(DatabaseLive),
//     Effect.mapError((error) => new ExtractGooglePlacesError({
//         message: error.message, metaData: JSON.stringify(error)
//     }))
// )