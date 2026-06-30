const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const WEB = path.join(ROOT, "web");
const RESOURCES = path.join(__dirname, "..", "resources");

function run(cmd, cwd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log("=== 1. Install web dependencies ===");
run("npm ci", WEB);

console.log("=== 2. Build Next.js ===");
run("npm run build", WEB);

console.log("=== 3. Install core dependencies ===");
run("yarn install --frozen-lockfile", ROOT);

console.log("=== 4. Assemble resources ===");
if (fs.existsSync(RESOURCES)) {
  fs.rmSync(RESOURCES, { recursive: true });
}
fs.mkdirSync(RESOURCES, { recursive: true });

const standalone = path.join(WEB, ".next", "standalone");
copyDir(standalone, RESOURCES);

copyDir(
  path.join(WEB, ".next", "static"),
  path.join(RESOURCES, "web", ".next", "static")
);
copyDir(
  path.join(WEB, "public"),
  path.join(RESOURCES, "web", "public")
);

fs.copyFileSync(
  path.join(ROOT, "batch-pay.ts"),
  path.join(RESOURCES, "batch-pay.ts")
);
copyDir(
  path.join(ROOT, "sample"),
  path.join(RESOURCES, "sample")
);
fs.copyFileSync(
  path.join(ROOT, "package.json"),
  path.join(RESOURCES, "package.json")
);
copyDir(
  path.join(ROOT, "node_modules"),
  path.join(RESOURCES, "node_modules")
);

console.log("=== Done! Resources assembled ===");
