/** Collab architecture boundaries (business-boundary monorepo). */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular deps are architecture defects.",
      from: {},
      to: { circular: true },
    },
    {
      name: "frontend-no-backend",
      severity: "error",
      comment: "Frontend must not import Backend (talk over HTTP).",
      from: { path: "^frontend/" },
      to: { path: "^backend/" },
    },
    {
      name: "frontend-no-database",
      severity: "error",
      comment: "Frontend must not import the database layer.",
      from: { path: "^frontend/" },
      to: { path: "^database/" },
    },
    {
      name: "frontend-no-mcp-agents",
      severity: "error",
      from: { path: "^frontend/" },
      to: { path: "^(mcp|agents)/" },
    },
    {
      name: "mcp-no-frontend",
      severity: "error",
      comment: "MCP must not import Frontend.",
      from: { path: "^mcp/" },
      to: { path: "^frontend/" },
    },
    {
      name: "agents-no-frontend",
      severity: "error",
      comment: "Agents must not reach into the UI.",
      from: { path: "^agents/" },
      to: { path: "^frontend/" },
    },
    {
      name: "backend-no-frontend",
      comment:
        "Backend production code must not depend on the frontend. Test files " +
        "are exempt so they can unit-test pure frontend helpers (e.g. the " +
        "identity resolver) directly, keeping a single source of truth.",
      severity: "error",
      from: { path: "^backend/", pathNot: "[.]test[.]ts$" },
      to: { path: "^frontend/" },
    },
    {
      name: "backend-no-mcp-agents",
      severity: "error",
      from: { path: "^backend/" },
      to: { path: "^(mcp|agents)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|[.]next|/dist/)" },
    enhancedResolveOptions: {
      extensions: [".js", ".jsx", ".ts", ".tsx", ".json"],
    },
    tsPreCompilationDeps: true,
  },
};
