#!/usr/bin/env node
/**
 * typecheck.mjs - strict TypeScript check for the extension source (no emit).
 *
 * pi loads extensions through jiti, which accepts .ts without a build step, but an
 * editor-agnostic `tsc --noEmit` catches type errors that jiti's lazy transform would
 * let through.
 *
 * Requires a local typescript (`npm i -D typescript`) OR falls back to `npx -y tsc`.
 * Exits non-zero on type errors.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const local = "node_modules/typescript/bin/tsc";
const use = existsSync(local)
  ? { bin: process.execPath, args: [local, "--noEmit", "--allowImportingTsExtensions", "--skipLibCheck", "--strict", "src/index.ts"] }
  : { bin: "npx", args: ["-y", "typescript", "--noEmit", "--allowImportingTsExtensions", "--skipLibCheck", "--strict", "src/index.ts"] };

const r = spawnSync(use.bin, use.args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);
