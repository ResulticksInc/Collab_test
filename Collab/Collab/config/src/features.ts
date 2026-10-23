// Feature flags. DEMO_MODE is a first-class product capability, not a hack.
import { bool } from "./env";

export const demoMode = bool("DEMO_MODE", false);
