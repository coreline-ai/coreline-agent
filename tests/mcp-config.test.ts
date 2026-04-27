/**
 * MCP config tests.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMcpConfig,
  loadMcpConfigWithStatus,
  mcpConfigFileSchema,
  parseMcpConfig,
  resolveDefaultMcpServerName,
  resolveMcpServerSelection,
} from "../src/mcp/config.js";

describe("MCP config", () => {
  test("parses server configs with defaults", () => {
    const parsed = parseMcpConfig({
      defaultServer: "local",
      servers: [
        {
          name: "local",
          command: "bun",
          args: ["server.ts"],
        },
      ],
    });

    expect(parsed.defaultServer).toBe("local");
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0]).toMatchObject({
      name: "local",
      command: "bun",
      args: ["server.ts"],
      enabled: true,
    });
  });

  test("loadMcpConfig returns an empty config when file is missing", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "coreline-mcp-config-"));
    try {
      const filePath = join(tmpDir, "missing.yml");
      const config = loadMcpConfig(filePath);
      expect(config).toEqual({ servers: [] });
      expect(resolveDefaultMcpServerName(config)).toBeUndefined();

      const status = loadMcpConfigWithStatus(filePath);
      expect(status.state).toBe("missing");
      expect(status.config).toEqual({ servers: [] });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("loadMcpConfig parses YAML files", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "coreline-mcp-config-"));
    try {
      const filePath = join(tmpDir, "mcp.yml");
      writeFileSync(
        filePath,
        [
          "defaultServer: local",
          "servers:",
          "  - name: local",
          "    command: bun",
          "    args:",
          "      - server.ts",
          "    timeoutMs: 2500",
        ].join("\n"),
        "utf-8",
      );

      const config = loadMcpConfig(filePath);
      expect(config.defaultServer).toBe("local");
      expect(config.servers[0]?.timeoutMs).toBe(2500);
      expect(resolveDefaultMcpServerName(config)).toBe("local");

      const selection = resolveMcpServerSelection(config);
      expect(selection.state).toBe("selected");
      expect(selection.selectedServerName).toBe("local");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("loadMcpConfigWithStatus marks invalid files", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "coreline-mcp-config-"));
    try {
      const filePath = join(tmpDir, "broken.yml");
      writeFileSync(
        filePath,
        [
          "servers:",
          "  - name: dup",
          "    command: bun",
          "  - name: dup",
          "    command: bun",
        ].join("\n"),
        "utf-8",
      );

      const status = loadMcpConfigWithStatus(filePath);
      expect(status.state).toBe("invalid");
      expect(status.error).toContain("Duplicate MCP server name");
      expect(status.config).toEqual({ servers: [] });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("schema rejects empty server names", () => {
    expect(() =>
      mcpConfigFileSchema.parse({
        servers: [{ name: "", command: "bun" }],
      }),
    ).toThrow();
  });

  test("rejects duplicate server names", () => {
    expect(() =>
      mcpConfigFileSchema.parse({
        servers: [
          { name: "local", command: "bun" },
          { name: "local", command: "bun" },
        ],
      }),
    ).toThrow(/Duplicate MCP server name/);
  });
});
