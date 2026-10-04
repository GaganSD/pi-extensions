import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

export const digest = value => createHash("sha256").update(value).digest("hex");
export function inventory(root) {
  const result = {};
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), key = relative(root, path);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isSymbolicLink()) {
        const target = realpathSync(path);
        assert(!lstatSync(target).isDirectory(), `Directory symlinks require an explicit separate inventory: ${path}`);
        result[key] = { link: readlinkSync(path), sha256: digest(readFileSync(target)) };
      } else if (stat.isFile()) result[key] = { sha256: digest(readFileSync(path)) };
      else throw new Error(`Unexpected runtime filesystem object: ${path}`);
    }
  }
  visit(root);
  return result;
}

function publicEndpoint(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`; // No userinfo, query or fragment.
}
function safeCompat(value) {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(^token$|apiKey|accessToken|refreshToken|auth|credential|header|password|secret)/i.test(key))
    .map(([key, entry]) => [key, entry && typeof entry === "object" ? safeCompat(entry) : entry]));
}
export function modelFingerprint(model, levels) {
  return {
    provider: model.provider, id: model.id, api: model.api,
    endpoint: publicEndpoint(model.baseUrl), reasoning: model.reasoning,
    input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    supportedThinking: levels, compat: safeCompat(model.compat ?? {}),
  };
}
