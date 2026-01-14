import { Workflow } from "@effect/workflow";
import { Effect, Schema } from "effect";
import { syncCrm, SyncCrmError } from "./activities/index.ts";
import { NodeContext } from "@effect/platform-node";

export const SyncCrmplaceDetailWorkflow = Workflow.make({
    name: "SyncCrmplaceDetailWorkflow",

    success: Schema.Void,
    error: SyncCrmError,
    payload: {
        id: Schema.String,
    },

    idempotencyKey: ({ id }) => `${id}-${new Date().toISOString()}`,
})


export const SyncCrmplaceDetailWorkflowLayer = SyncCrmplaceDetailWorkflow.toLayer(
    Effect.fn(function* (payload, executionId) {
        yield* syncCrm({ payload, executionId }).pipe(
            // Effect.provide(BrowserLockLive),
            Effect.provide(NodeContext.layer),
        )
        yield* Effect.log({
            payload,
            executionId
        })
    })
)
