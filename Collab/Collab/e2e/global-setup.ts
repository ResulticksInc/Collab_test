import { prepareReleaseDatabases } from "../database/src/prepare-release-dbs";

export default async function globalSetup() {
  await prepareReleaseDatabases();
}
