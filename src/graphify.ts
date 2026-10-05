import { registerSlashCommand, type SlashCommandFn } from "./slash";
import { resolve } from "./tools/fs-utils";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const colors = {
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

interface GraphifyConfig {
  graphDir: string;
  defaultMode: "code" | "nl";
  apiKey?: string;
}

let graphifyConfig: GraphifyConfig = {
  graphDir: "./graphify_out/graphify-out",
  defaultMode: "code",
};

function print(tui: any, s: string): void {
  if (tui) tui.printToScrollback(s);
  else console.log(s);
}

function findGraphDir(cwd: string): string {
  // Check configured dir first
  if (existsSync(graphifyConfig.graphDir)) return graphifyConfig.graphDir;
  // Check common locations
  const candidates = [
    join(cwd, "graphify_out", "graphify-out"),
    join(cwd, ".graphify", "graphify-out"),
    join(cwd, "graphify-out"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return graphifyConfig.graphDir; // fallback
}

function loadGraphStats(graphDir: string): { nodes: number; edges: number; communities: number } | null {
  const graphPath = join(graphDir, "graph.json");
  if (!existsSync(graphPath)) return null;
  try {
    const data = JSON.parse(readFileSync(graphPath, "utf8"));
    const nodeCount = data.nodes?.length ?? 0;
    const edgeCount = data.links?.length ?? 0;
    const communitySet = new Set(
      (data.nodes ?? [])
        .map((n: any) => n.community)
        .filter((c: any) => c !== undefined && c !== null)
    );
    return {
      nodes: nodeCount,
      edges: edgeCount,
      communities: communitySet.size,
    };
  } catch {
    return null;
  }
}

async function runGraphify(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const graphDir = findGraphDir(cwd);
  const fullArgs = ["-m", "graphify", ...args, "--graph-dir", graphDir];
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process");
    const proc = spawn("python", fullArgs, { cwd, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code: number) => resolve({ code: code ?? 1, stdout, stderr }));
    proc.on("error", (err: Error) => resolve({ code: 127, stdout, stderr: err.message }));
  });
}

async function handleQuery(argv: string, tui: any, cwd: string): Promise<boolean> {
  const args = argv.trim().split(/\s+/);
  if (!args[0] || args[0] === "help") {
    print(tui, `${colors.bold}graphify query${colors.reset} — query the knowledge graph`);
    print(tui, `  ${colors.green}/graphify query "your question"${colors.reset}     natural language (needs API key)`);
    print(tui, `  ${colors.green}/graphify query --code "your question"${colors.reset}  code-only (no key needed)`);
    print(tui, `  ${colors.green}/graphify query --mode code|nl "..."${colors.reset}   explicit mode`);
    print(tui, `  ${colors.dim}Examples:${colors.reset}`);
    print(tui, `  ${colors.dim}  /graphify query "how does the REPL connect to the agent loop?"${colors.reset}`);
    print(tui, `  ${colors.dim}  /graphify query --code "what calls handleCommand?"${colors.reset}`);
    return true;
  }

  const modeIdx = args.indexOf("--mode");
  const codeIdx = args.indexOf("--code");
  const nlIdx = args.indexOf("--nl");

  let mode: "code" | "nl" = graphifyConfig.defaultMode;
  // Only accept a --mode value that is actually a valid mode, so a typo in
  // config.json or on the command line cannot smuggle in an arbitrary string.
  const modeArg = modeIdx !== -1 ? args[modeIdx + 1] : undefined;
  if (modeArg === "code" || modeArg === "nl") mode = modeArg;
  else if (codeIdx !== -1) mode = "code";
  else if (nlIdx !== -1) mode = "nl";

  const query = args
    .filter((_, i) => i !== modeIdx && i !== modeIdx + 1 && i !== codeIdx && i !== nlIdx)
    .join(" ");

  if (!query) {
    print(tui, `${colors.red}usage: /graphify query [--code|--nl|--mode code|nl] "question"${colors.reset}`);
    return true;
  }

  print(tui, `${colors.dim}querying graph (${mode} mode)…${colors.reset}`);
  const res = await runGraphify(["query", `--${mode}`, query], cwd);

  if (res.code !== 0) {
    print(tui, `${colors.red}query failed:${colors.reset} ${res.stderr || res.stdout}`);
    return true;
  }

  print(tui, res.stdout || `${colors.dim}(no results)${colors.reset}`);
  return true;
}

async function handleStats(argv: string, tui: any, cwd: string): Promise<boolean> {
  const graphDir = findGraphDir(cwd);
  const stats = loadGraphStats(graphDir);

  if (!stats) {
    print(tui, `${colors.red}no graph found at ${graphDir}${colors.reset}`);
    print(tui, `${colors.dim}run: graphify build . --code-only${colors.reset}`);
    return true;
  }

  print(tui, `${colors.bold}Graph Statistics${colors.reset}`);
  print(tui, `  ${colors.cyan}Nodes:${colors.reset}       ${stats.nodes}`);
  print(tui, `  ${colors.cyan}Edges:${colors.reset}       ${stats.edges}`);
  print(tui, `  ${colors.cyan}Communities:${colors.reset} ${stats.communities}`);
  print(tui, `  ${colors.cyan}Graph dir:${colors.reset}   ${graphDir}`);

  // Show report if exists
  const reportPath = join(graphDir, "GRAPH_REPORT.md");
  if (existsSync(reportPath)) {
    const report = readFileSync(reportPath, "utf8");
    const lines = report.split("\n").slice(0, 30);
    print(tui, `\n${colors.dim}--- GRAPH_REPORT.md (first 30 lines) ---${colors.reset}`);
    for (const line of lines) print(tui, line);
  }
  return true;
}

async function handleUpdate(argv: string, tui: any, cwd: string): Promise<boolean> {
  const args = argv.trim().split(/\s+/);
  const codeOnly = args.includes("--code-only") || args.includes("-c");
  const watch = args.includes("--watch") || args.includes("-w");

  print(tui, `${colors.dim}updating graph${codeOnly ? " (code-only)" : ""}${watch ? " + watch mode" : ""}…${colors.reset}`);
  const res = await runGraphify(["update", codeOnly ? "--code-only" : "", watch ? "--watch" : ""].filter(Boolean), cwd);

  if (res.code !== 0) {
    print(tui, `${colors.red}update failed:${colors.reset} ${res.stderr || res.stdout}`);
    return true;
  }

  print(tui, `${colors.green}graph updated${colors.reset}`);
  if (res.stdout) print(tui, res.stdout);
  return true;
}

async function handleBuild(argv: string, tui: any, cwd: string): Promise<boolean> {
  const args = argv.trim().split(/\s+/);
  const codeOnly = args.includes("--code-only") || args.includes("-c");
  const wiki = args.includes("--wiki");
  const includeRaw = args.includes("--include-raw");

  print(tui, `${colors.dim}building graph${codeOnly ? " (code-only)" : ""}${wiki ? " + wiki" : ""}${includeRaw ? " + raw" : ""}…${colors.reset}`);
  const res = await runGraphify(
    ["build", ".", codeOnly ? "--code-only" : "", wiki ? "--wiki" : "", includeRaw ? "--include-raw" : ""].filter(Boolean),
    cwd
  );

  if (res.code !== 0) {
    print(tui, `${colors.red}build failed:${colors.reset} ${res.stderr || res.stdout}`);
    return true;
  }

  print(tui, `${colors.green}graph built${colors.reset}`);
  if (res.stdout) print(tui, res.stdout);
  return true;
}

async function handleExport(argv: string, tui: any, cwd: string): Promise<boolean> {
  const args = argv.trim().split(/\s+/);
  if (!args[0] || args[0] === "help") {
    print(tui, `${colors.bold}graphify export${colors.reset} — export graph to other formats`);
    print(tui, `  ${colors.green}/graphify export neo4j${colors.reset}     Neo4j Cypher import`);
    print(tui, `  ${colors.green}/graphify export graphml${colors.reset}    GraphML (Gephi, yEd, etc.)`);
    print(tui, `  ${colors.green}/graphify export svg${colors.reset}       SVG visualization`);
    print(tui, `  ${colors.green}/graphify export mcp${colors.reset}       MCP server config`);
    return true;
  }

  const format = args[0];
  const valid = ["neo4j", "graphml", "svg", "mcp"];
  if (!valid.includes(format)) {
    print(tui, `${colors.red}unknown format: ${format}${colors.reset}`);
    print(tui, `${colors.dim}valid: ${valid.join(", ")}${colors.reset}`);
    return true;
  }

  print(tui, `${colors.dim}exporting to ${format}…${colors.reset}`);
  const res = await runGraphify(["export", format], cwd);

  if (res.code !== 0) {
    print(tui, `${colors.red}export failed:${colors.reset} ${res.stderr || res.stdout}`);
    return true;
  }

  print(tui, `${colors.green}export complete${colors.reset}`);
  if (res.stdout) print(tui, res.stdout);
  return true;
}

async function handleMcp(argv: string, tui: any, cwd: string): Promise<boolean> {
  const args = argv.trim().split(/\s+/);
  const port = args[0] ? parseInt(args[0], 10) : 3001;

  print(tui, `${colors.dim}starting MCP server on port ${port}…${colors.reset}`);
  print(tui, `${colors.yellow}Note: this runs in foreground. Use a separate terminal or background it.${colors.reset}`);

  const { spawn } = require("node:child_process");
  const graphDir = findGraphDir(cwd);
  const proc = spawn("graphify", ["mcp", "--graph-dir", graphDir, "--port", String(port)], {
    cwd,
    stdio: "inherit",
  });

  proc.on("close", (code: number) => {
    print(tui, `${colors.dim}MCP server exited (code ${code})${colors.reset}`);
  });

  // Don't wait — let it run
  return true;
}

async function handleConfig(argv: string, tui: any, cwd: string): Promise<boolean> {
  const args = argv.trim().split(/\s+/);
  if (!args[0] || args[0] === "show") {
    print(tui, `${colors.bold}Graphify Config${colors.reset}`);
    print(tui, `  graphDir:   ${graphifyConfig.graphDir}`);
    print(tui, `  defaultMode: ${graphifyConfig.defaultMode}`);
    print(tui, `  apiKey:     ${graphifyConfig.apiKey ? "***set***" : "not set"}`);
    return true;
  }

  if (args[0] === "set") {
    const key = args[1];
    const value = args.slice(2).join(" ");
    if (!key || !value) {
      print(tui, `${colors.red}usage: /graphify config set <key> <value>${colors.reset}`);
      print(tui, `${colors.dim}keys: graphDir, defaultMode, apiKey${colors.reset}`);
      return true;
    }
    if (key === "graphDir") graphifyConfig.graphDir = resolve(value, { cwd });
    else if (key === "defaultMode") {
      if (!["code", "nl"].includes(value)) {
        print(tui, `${colors.red}defaultMode must be 'code' or 'nl'${colors.reset}`);
        return true;
      }
      graphifyConfig.defaultMode = value as "code" | "nl";
    } else if (key === "apiKey") graphifyConfig.apiKey = value;
    else {
      print(tui, `${colors.red}unknown key: ${key}${colors.reset}`);
      return true;
    }
    print(tui, `${colors.green}config updated${colors.reset}`);
    return true;
  }

  print(tui, `${colors.red}usage: /graphify config [show|set <key> <value>]${colors.reset}`);
  return true;
}

async function handleHelp(_argv: string, tui: any): Promise<boolean> {
  print(tui, `\n${colors.bold}/graphify — Knowledge Graph Integration${colors.reset}`);
  print(tui, ``);
  print(tui, `${colors.green}/graphify query "question"${colors.reset}      Ask the graph (NL mode, needs API key)`);
  print(tui, `${colors.green}/graphify query --code "question"${colors.reset}  Code-only query (no key needed)`);
  print(tui, `${colors.green}/graphify stats${colors.reset}                 Show graph statistics`);
  print(tui, `${colors.green}/graphify build [--code-only] [--wiki]${colors.reset}  Build/rebuild the graph`);
  print(tui, `${colors.green}/graphify update [--code-only] [--watch]${colors.reset}  Incremental update`);
  print(tui, `${colors.green}/graphify export <format>${colors.reset}        Export: neo4j, graphml, svg, mcp`);
  print(tui, `${colors.green}/graphify mcp [port]${colors.reset}             Start MCP server (default 3001)`);
  print(tui, `${colors.green}/graphify config [show|set key val]${colors.reset}  Configure graphify`);
  print(tui, `${colors.green}/graphify help${colors.reset}                 This help`);
  print(tui, ``);
  print(tui, `${colors.dim}Graph dir: ${findGraphDir(process.cwd())}${colors.reset}`);
  return true;
}

export function registerGraphifyCommands(getCwd: () => string): void {
  const handler: SlashCommandFn = async (argv, tui) => {
    const cwd = getCwd();
    const args = argv.trim().split(/\s+/);
    const sub = args[0]?.toLowerCase() || "help";

    switch (sub) {
      case "query":
      case "q":
        return handleQuery(args.slice(1).join(" "), tui, cwd);
      case "stats":
      case "stat":
      case "s":
        return handleStats(argv, tui, cwd);
      case "build":
      case "b":
        return handleBuild(args.slice(1).join(" "), tui, cwd);
      case "update":
      case "u":
        return handleUpdate(args.slice(1).join(" "), tui, cwd);
      case "export":
      case "e":
        return handleExport(args.slice(1).join(" "), tui, cwd);
      case "mcp":
        return handleMcp(args.slice(1).join(" "), tui, cwd);
      case "config":
      case "cfg":
        return handleConfig(args.slice(1).join(" "), tui, cwd);
      case "help":
      case "h":
      default:
        return handleHelp(argv, tui);
    }
  };

  registerSlashCommand({
    name: "graphify",
    label: "graphify",
    description: "query & manage the codebase knowledge graph (query, stats, build, update, export, mcp)",
    handler,
  });
}