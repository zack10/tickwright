import prisma from "../db";
import { NonRetryableError } from "../utils/safeError";
import { HttpConnector } from "./connectors/httpConnector";
import { McpConnector, McpResponse } from "./connectors/types";

class McpService {
  private readonly connectors: Map<string, McpConnector> = new Map();

  constructor() {
    this.registerConnector(new HttpConnector());
    // Register other connectors here
  }

  public registerConnector(connector: McpConnector) {
    this.connectors.set(connector.type, connector);
  }

  public async executeMcpAction(
    resourceId: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<McpResponse> {
    const resource = await prisma.mCPResource.findUnique({
      where: { id: resourceId },
    });

    if (!resource) {
      throw new Error("Resource not found");
    }

    const connector = this.connectors.get(resource.type);

    if (!connector) {
      throw new NonRetryableError(`No connector for MCP resource type "${resource.type}"`);
    }

    const connectorConfig = resource.config as Record<string, unknown>;
    return connector.execute(action, params, connectorConfig);
  }
}

const mcpService = new McpService();
export const executeMcpAction = mcpService.executeMcpAction.bind(mcpService);
export default mcpService;
