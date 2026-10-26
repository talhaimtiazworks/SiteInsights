#!/usr/bin/env node
/** Canonical palette shared by CSS, PDF and email templates. No application dependency. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { colors, themes } = JSON.parse(readFileSync(path.join(root, "src/lib/design-tokens.json"), "utf8"));
const rgb = (hex) => [1, 3, 5].map((n) => parseInt(hex.slice(n, n + 2), 16)).join(" ");
function block(selector, values, scheme) {
  let css = `${selector} {\n`;
  for (const [key, value] of Object.entries(values)) css += `  --${key}: ${rgb(colors[value])};\n`;
  for (const [key, value] of Object.entries(colors)) css += `  --color-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value};\n`;
  for (const [token, source] of Object.entries({ background: "background", surface: "card", text: "foreground", secondary: "secondary", muted: "muted-foreground", border: "border" })) css += `  --color-${token}: ${colors[values[source]]};\n`;
  return css + `  color-scheme: ${scheme};\n}\n`;
}
let css = "/* Generated from src/lib/design-tokens.json. Run node scripts/brand/generate-tokens.mjs. */\n";
for (const [theme, values] of Object.entries(themes)) css += block(theme === "light" ? ":root" : `.${theme}`, values, "light");
// Printing always uses a white page.
css += "@media print {\n" + block(":root", { ...themes.light, background: "white" }, "light") + "}\n";
const output = path.join(root, "src/app/brand-tokens.css");
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== css) throw new Error("brand-tokens.css is stale; regenerate it from design-tokens.json");
  console.log("Central brand tokens are synchronized.");
} else { writeFileSync(output, css); console.log("Generated brand-tokens.css"); }
