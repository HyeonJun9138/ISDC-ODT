// The one server deployment client of this console. The node tab and the scenario player both
// deploy through it, so the accepted server configuration and the browser's deployed set are
// tracked once. Import this module with exactly this path (no cache query) from every owner.
import { emit } from "../state.js";
import { constellation } from "./constellation.js";
import { createDataDeployment } from "./data_deployment.js?v=20260908-scenario1";

export const dataDeployment = createDataDeployment({ constellation, emit });
