import { Layer } from "effect";
import { PlacesLocatorWorkflowLayer } from "./placesLocator/workflow.ts";
import { PlaceWebsiteScraperWorkflowLayer } from "./placeWebsiteScraper/workflow.ts";
import { SyncCrmplaceDetailWorkflowLayer } from "./syncCrmPlaceDetail/workflow.ts";

export const WorkflowsLayer = Layer.mergeAll(
    PlacesLocatorWorkflowLayer,
    PlaceWebsiteScraperWorkflowLayer,
    SyncCrmplaceDetailWorkflowLayer
)

