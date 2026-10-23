// Driver selection: DATABASE_DRIVER=json → lightweight JSON file store for
// local development (no Docker/MySQL needed). Everything else stays MySQL.
let _instance: any = null;
function getDb(config: any) {
  if (!_instance) {
    const driver = (process.env.DATABASE_DRIVER || "mysql").toLowerCase().trim();
    if (driver === "json") {
      const { createJsonDb } = require("./drivers/json");
      _instance = createJsonDb(config);
      console.log("[db] Using JSON file driver (local-data/). No MySQL needed.");
    } else {
      const { createMysqlDb } = require("./drivers/mysql");
      _instance = createMysqlDb(config);
    }
  }
  return _instance;
}
export { getDb };
export { orgContext, currentOrgId } from "./orgContext";
export { ensureDatabase, migrate, promoteIfNeeded, isTransientDbError } from "./bootstrap";
