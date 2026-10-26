#!/usr/bin/env node
/** Compatibility entry point. Official assets ship pre-generated. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
execFileSync("python3", [fileURLToPath(new URL("./generate.py", import.meta.url))], { stdio: "inherit" });
