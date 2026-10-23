import { backendGateway } from "../server/gateway";
import { prompts } from "../prompts";
import { createResources } from "../resources";
import { createTools } from "../tools";

export function registry() {
  return {
    tools: createTools(backendGateway),
    resources: createResources(backendGateway),
    prompts,
  };
}
