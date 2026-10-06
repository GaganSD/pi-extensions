import { appendFileSync } from "node:fs";
import { packages } from "./packages.mjs";
import { git, isMain } from "./lib.mjs";

export function affectedPackages(files) {
  const names = Object.keys(packages);
  const shared = files.some(file =>
    !names.some(name => file.startsWith(name + "/")) &&
    !/^(?:(?:README\.md|LICENSE|llms\.txt)$|(?:docs|reports)\/)/.test(file));
  return shared ? names : names.filter(name => files.some(file => file.startsWith(name + "/")));
}

// Extra cross-platform and Pi-version legs for the one package with runtime
// differences. They ride in the same matrix as the standard package legs.
const webCompatLegs = [
  { package: "pi-web-search", os: "ubuntu-latest", node: "22.19.0", pi: "0.99.0", kind: "compat", label: "Linux, Pi 0.99" },
  { package: "pi-web-search", os: "windows-latest", node: "24.x", pi: "0.99.0", kind: "compat", label: "Windows, Pi 0.99" },
  { package: "pi-web-search", os: "macos-latest", node: "24.x", pi: "1.0.0", kind: "compat", label: "macOS, Pi 1.0" },
];

export function ciMatrix(paths) {
  const legs = paths.map(name => ({ package: name, os: "ubuntu-latest", node: "24", kind: "package" }));
  if (paths.includes("pi-web-search")) legs.push(...webCompatLegs);
  return legs;
}

if (isMain(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  if (!/^[a-f0-9]{40}$/.test(head ?? "")) throw new Error("Expected a full head SHA");
  const paths = !base || /^0+$/.test(base) ? Object.keys(packages)
    : affectedPackages(git("diff", "--name-only", "--no-renames", base, head).split("\n").filter(Boolean));
  const output = `has_packages=${paths.length > 0}\nmatrix=${JSON.stringify({ include: ciMatrix(paths) })}\n`;
  process.stdout.write(output);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
}
