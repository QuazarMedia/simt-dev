const { existsSync } = require("node:fs");
process.exitCode = Number(!existsSync("handbook/current.md"));
