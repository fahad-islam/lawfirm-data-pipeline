import { Config, DateTime, Effect, Layer, Option, Schedule } from "effect"
import { WorkflowsLayer } from "./workflows/index.ts"
import { PlacesLocatorWorkflow, PlacesLocatorWorkflowLayer } from "./workflows/placesLocator/workflow.ts"
import { NodeClusterSocket, NodeRuntime } from "@effect/platform-node"
import { PrismaService } from "./db/client/effect.ts"
import { DatabaseLive } from "./db/index.ts"
import { seconds } from "effect/Duration"
import { ClusterWorkflowEngine, RunnerAddress } from "@effect/cluster"
import { PgClient } from "@effect/sql-pg"

export const WorkflowEngineLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const url = yield* Config.redacted("PlacesLocator_DATABASE_URL")

    return ClusterWorkflowEngine.layer.pipe(
      Layer.provideMerge(
        NodeClusterSocket.layer({
          shardingConfig: {
            runnerListenAddress: Option.some(RunnerAddress.make(
              "0.0.0.0",
              3030
            )),
            runnerAddress: Option.some(RunnerAddress.make(
              "localhost",
              3030
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

Effect.gen(function* () {
  // const now = yield* DateTime.now;
  // yield* Effect.log(`Cronning at ${DateTime.formatIso(now)}`);
  const db = yield* PrismaService;

  const count = yield* db.googlePlaceUrlToScrape.count({
    where: {
      status: null
    },
  });

  yield* Effect.log({
    Done: true,
    count
  })
}).pipe(
  Effect.scoped,
  Effect.provide(DatabaseLive),
  NodeRuntime.runMain
);
