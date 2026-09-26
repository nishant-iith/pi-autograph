import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, ["--experimental-transform-types", "--test", "tests/core.test.ts"], { stdio: "inherit" });
process.exit(r.status ?? 1);
