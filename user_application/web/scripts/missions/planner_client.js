// The one mission planner of this console, shared by the mission tab and the scenario player so the
// window cache, the external-satellite library and the module client are created once. The mission
// tab registers its analysis clock as the planner's time source; while a scenario plays every tab
// clock follows the scenario clock, so both callers plan at the same instant.
import { store } from "../state.js";
import { constellation } from "../nodes/constellation.js";
import { groundSegment } from "../communication/ground_segment.js";
import { missionStore } from "./mission_store.js";
import { createMissionPlanner } from "./planner.js";

export const missionPlanner = createMissionPlanner({
  satellites: () => constellation.deployed,
  stations: () => groundSegment.enabled,
  missions: () => missionStore.missions,
  faults: () => store.runtime?.active_faults || [],
});
