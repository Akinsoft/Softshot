const { execFileSync } = require("node:child_process");
const { mkdirSync } = require("node:fs");
const path = require("node:path");

const builderImage = "debian:sid@sha256:c53e050391cca6c8517c4a075230b798a0f980faa5d3ed0a912249ea882e40b5";
const projectRoot = path.join(__dirname, "..");
const scriptDirectory = path.join(__dirname, "ffmpeg");
const outputDirectory = path.join(projectRoot, "vendor", "ffmpeg");

mkdirSync(outputDirectory, { recursive: true });
execFileSync(
  "docker",
  [
    "run",
    "--rm",
    "--volume",
    `${scriptDirectory}:/build:ro`,
    "--volume",
    `${outputDirectory}:/out`,
    builderImage,
    "bash",
    "/build/build.sh"
  ],
  { env: { ...process.env, MSYS_NO_PATHCONV: "1" }, stdio: "inherit" }
);
