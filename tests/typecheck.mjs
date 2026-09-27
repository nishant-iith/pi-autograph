#!/usr/bin/env node
/**
 * typecheck.mjs - strict TypeScript check for the extension source (no emit).
 *
 * pi loads extensions through jiti, which accepts .ts without a build step, but an
 * editor-agnostic `tsc --noEmit` catches type errors that jiti's lazy transform would
 * let through.
 *
 * Uses `npx tsc` which handles paths correctly.
 * Exits non-zero on type errors.
 */
import { spawnSync } from "node:child_process";

const cmd = "npx tsc --noEmit --project tsconfig.json";

const r = spawnSync(cmd, { stdio: "inherit", shell: true });
process.exit(r.status ?? 1);