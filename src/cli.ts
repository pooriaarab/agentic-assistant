#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { VERSION } from "./version.js";

const HELP = [
  `agentic-assistant ${VERSION}`,
  "An AI assistant that acts inside your apps with the user's own permissions.",
  "",
  "Usage: agentic-assistant [--help] [--version]",
].join("\n");

export function runCli(argv: string[], out: (line: string) => void = console.log, err: (line: string) => void = console.error): number {
  const [first] = argv;
  if (first === undefined || first === "--help" || first === "-h") {
    out(HELP);
    return 0;
  }
  if (first === "--version" || first === "-V") {
    out(VERSION);
    return 0;
  }
  err(`unknown command "${first}"`);
  err('Run "agentic-assistant --help" for usage.');
  return 2;
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const code = runCli(process.argv.slice(2));
  if (code !== 0) process.exit(code);
}
