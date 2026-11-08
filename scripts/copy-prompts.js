// tsc only emits .js, so the prompt templates are copied into dist/ by hand.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
fs.cpSync(path.join(root, "src", "prompts"), path.join(root, "dist", "prompts"), {
  recursive: true,
  filter: (source) => !source.endsWith(".ts"),
});
