#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL("..", import.meta.url));
const templateDir = resolve(__dirname, "template");

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const interactive = process.stdin.isTTY && process.stdout.isTTY && !args.yes;
const rl = interactive
  ? createInterface({
      input: process.stdin,
      output: process.stdout,
    })
  : null;

try {
  const targetArg = args._[0] || (interactive ? await promptText(rl, "Project directory", "docs") : "docs");
  const targetDir = targetArg || "docs";
  const targetPath = resolve(process.cwd(), targetDir);

  if (!(await isEmptyDirectory(targetPath))) {
    throw new Error(`Target directory is not empty: ${targetDir}`);
  }

  const inferredName = inferProjectName(targetPath);
  const projectName = interactive
    ? await promptText(rl, "Project name", inferredName)
    : inferredName;
  const githubRepo = args.github
    || (interactive
      ? await promptRequired(rl, "GitHub repository (owner/repo)", "owner/repo")
      : "owner/repo");
  const installDeps = args.install ?? (interactive ? await promptConfirm(rl, "Install dependencies?", true) : false);

  await mkdir(targetPath, { recursive: true });
  await copyTemplate(templateDir, targetPath, {
    "__PROJECT_NAME__": projectName,
    "__PROJECT_SLUG__": slugify(projectName),
    "__GITHUB_REPO__": githubRepo,
  });

  console.log("");
  console.log(`Created NuDocs project in ${relative(process.cwd(), targetPath) || "."}`);

  if (installDeps) {
    const packageManager = detectPackageManager();
    console.log(`Installing dependencies with ${packageManager}...`);
    await runInstall(packageManager, targetPath);
  }

  console.log("");
  console.log("Next steps:");
  if (targetDir !== ".") {
    console.log(`  cd ${targetDir}`);
  }
  if (!installDeps) {
    console.log(`  ${detectPackageManager()} install`);
  }
  console.log(`  ${detectPackageManager()} run dev`);
}
catch (error) {
  console.error("");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
finally {
  rl?.close();
}

function parseArgs(argv) {
  const parsed = {
    _: [],
    help: false,
    yes: false,
    github: "",
    install: undefined,
  };

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];

    if (value === "-h" || value === "--help") {
      parsed.help = true;
      continue;
    }

    if (value === "-y" || value === "--yes") {
      parsed.yes = true;
      continue;
    }

    if (value === "--install") {
      parsed.install = true;
      continue;
    }

    if (value === "--no-install") {
      parsed.install = false;
      continue;
    }

    if (value === "--github") {
      parsed.github = argv[index + 1] || "";
      index++;
      continue;
    }

    if (value.startsWith("--github=")) {
      parsed.github = value.slice("--github=".length);
      continue;
    }

    parsed._.push(value);
  }

  return parsed;
}

function printHelp() {
  console.log("Usage: npm create nudocs@latest [dir]");
  console.log("");
  console.log("Options:");
  console.log("  -y, --yes            Skip prompts and use defaults");
  console.log("  --github owner/repo  Set the GitHub repository");
  console.log("  --install            Install dependencies");
  console.log("  --no-install         Skip dependency installation");
}

async function promptText(rl, label, defaultValue = "") {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const value = (await rl.question(`${label}${suffix}: `)).trim();
  return value || defaultValue;
}

async function promptRequired(rl, label, defaultValue = "") {
  while (true) {
    const value = await promptText(rl, label, defaultValue);
    if (value) {
      return value;
    }
    console.log("Please enter a value.");
  }
}

async function promptConfirm(rl, label, defaultValue) {
  const suffix = defaultValue ? "Y/n" : "y/N";

  while (true) {
    const value = (await rl.question(`${label} (${suffix}): `)).trim().toLowerCase();
    if (!value) {
      return defaultValue;
    }
    if (value === "y" || value === "yes") {
      return true;
    }
    if (value === "n" || value === "no") {
      return false;
    }
  }
}

async function isEmptyDirectory(path) {
  if (!existsSync(path)) {
    return true;
  }

  const entries = await readdir(path);
  return entries.length === 0;
}

function inferProjectName(targetPath) {
  const targetName = basename(targetPath);
  const source = targetName === "." || targetName === "docs" ? basename(process.cwd()) : targetName;
  return titleCase(source || "nudocs");
}

function titleCase(value) {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

async function copyTemplate(sourceDir, targetDir, replacements) {
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyTemplate(sourcePath, targetPath, replacements);
      continue;
    }

    const contents = await readFile(sourcePath, "utf8");
    const rendered = Object.entries(replacements).reduce((result, [key, value]) => {
      return result.replaceAll(key, value);
    }, contents);

    await writeFile(targetPath, rendered, "utf8");
  }
}

function detectPackageManager() {
  const userAgent = process.env.npm_config_user_agent || "";

  if (userAgent.startsWith("pnpm")) {
    return "pnpm";
  }

  if (userAgent.startsWith("yarn")) {
    return "yarn";
  }

  if (userAgent.startsWith("bun")) {
    return "bun";
  }

  return "npm";
}

async function runInstall(packageManager, cwd) {
  const args = packageManager === "npm" ? ["install"] : ["install"];

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(packageManager, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`${packageManager} install failed with exit code ${code}`));
    });
  });
}
