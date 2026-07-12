const { writeFileSync } = require("node:fs");
const path = require("node:path");

writeFileSync(
  path.join(__dirname, "..", "dist", "browser", "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`
);
