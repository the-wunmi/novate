import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { DomainError, type Principal, toJson } from '@novate/core';
import { AGENT_TOOLS, type AgentTool } from './agent-tools.ts';

const text = (value: string, isError = false) => ({
  content: [{ type: 'text' as const, text: value }],
  isError,
});

/** A domain error is the agent's to act on. Anything else stays in the logs. */
function failure(tool: AgentTool, err: unknown) {
  if (err instanceof DomainError) return text(`${err.code}: ${err.message}`, true);
  console.error(`Agent tool ${tool.name} failed:`, err);
  return text('internal error', true);
}

/** One server per request: it has no state of its own, and each carries only the caller's identity. */
function serverFor(principal: Principal): McpServer {
  const server = new McpServer({ name: 'novate', version: '1.0.0' });
  for (const tool of AGENT_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (input: unknown) => {
        try {
          return text(toJson(await tool.run(principal, input)));
        } catch (err) {
          return failure(tool, err);
        }
      },
    );
  }
  return server;
}

/** MCP over HTTP, for agents trading through novate. The API key decides what each one can do. */
export async function handleMcp(principal: Principal, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await serverFor(principal).connect(transport);
  return transport.handleRequest(request);
}
