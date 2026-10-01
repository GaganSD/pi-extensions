import { readStoredCredential } from "@earendil-works/pi-coding-agent";

/** Secrets loaded from Pi auth.json. Env always wins. Never written back. */
const fromAuth = new Map<string, string>();

const AUTH_ENV: Record<string, readonly string[]> = {
	PARALLEL_API_KEY: ["parallel"],
	EXA_API_KEY: ["exa"],
	GITHUB_TOKEN: ["github"],
	TYPESAFE_API_KEY: ["typesafe"],
	AI_GATEWAY_API_KEY: ["vercel-ai-gateway"],
};

/** Trimmed env lookup. Whitespace-only values are absent, not present. */
export function readTrimmedEnv(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name] ?? fromAuth.get(name);
		if (typeof value !== "string") {
			continue;
		}
		const trimmed = value.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return undefined;
}

/**
 * Pull search keys out of Pi's gitignored auth.json. Tests never call this,
 * so the suite stays hermetic.
 */
export function hydrateFromPiAuth(): void {
	// node:test sets this; never read the operator's auth.json from the suite.
	if (process.env.NODE_TEST_CONTEXT !== undefined) {
		return;
	}
	for (const [envName, providers] of Object.entries(AUTH_ENV)) {
		if (readTrimmedEnv(envName) !== undefined) {
			continue;
		}
		for (const providerId of providers) {
			try {
				const stored = readStoredCredential(providerId);
				const key = typeof stored?.key === "string" ? stored.key.trim() : "";
				if (key.length > 0) {
					fromAuth.set(envName, key);
					break;
				}
			} catch {
				// auth.json is optional
			}
		}
	}
}

export function exaApiKey(): string | undefined {
	return readTrimmedEnv("EXA_API_KEY");
}

export function parallelApiKey(): string | undefined {
	return readTrimmedEnv("PARALLEL_API_KEY");
}

export function githubToken(): string | undefined {
	return readTrimmedEnv("GITHUB_TOKEN", "GH_TOKEN");
}
