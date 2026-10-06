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

// One combined leg per package: a single job and a single check name keep the
// required-status list and the release gate simple.
export function ciMatrix(paths) {
  return paths.map(name => ({ package: name }));
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
