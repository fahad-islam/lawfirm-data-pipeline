import { Workflow } from "@effect/workflow";
import { Effect, Schema } from "effect";
import { scrapeWebsite, ScrapeWebsiteError } from "./activities/index.ts";

export const PlaceWebsiteScraperWorkflow = Workflow.make({
    name: "PlaceWebsiteScraperWorkflow",

    success: Schema.Void,
    error: ScrapeWebsiteError,
    payload: {
        id: Schema.String,
        name: Schema.NullOr(Schema.String),
        url: Schema.String,
        address: Schema.NullOr(Schema.String),
        phone: Schema.NullOr(Schema.String),
        location: Schema.String,
    },

    idempotencyKey: ({ id }) => `${id}-${new Date().toISOString()}`,
})


export const PlaceWebsiteScraperWorkflowLayer = PlaceWebsiteScraperWorkflow.toLayer(
    Effect.fn(function* (payload, executionId) {
        yield* scrapeWebsite({ payload, executionId })
        yield* Effect.log({
            payload,
            executionId
        })
    })
)
