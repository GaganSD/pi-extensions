import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_ASK_CONFIG,
	normalizeAskConfig,
	toAskConfigFile,
} from "./defaults.ts";
import { type AskConfig, validateAskConfigFile } from "./schema.ts";

const INVALID_CONFIG_NOTICE =
	"Config was invalid or unsupported. Loaded defaults for this session and left the config file unchanged. Edit the config file or run /reload after fixing it.";

export interface AskConfigNotice {
	kind: "error" | "warning" | "success";
	text: string;
}

interface AskConfigLoadResult {
	config: AskConfig;
	notice?: AskConfigNotice;
}

export class AskConfigStore {
	private config?: AskConfig;
	private loadPromise?: Promise<AskConfigLoadResult>;
	private notice?: AskConfigNotice;
	private readonly listeners = new Set<(config: AskConfig) => void>();
	private readonly configPath: string;

	constructor(configPath?: string) {
		this.configPath = configPath ?? getAskConfigPath();
	}

	subscribe(onChange: (config: AskConfig) => void): () => void {
		this.listeners.add(onChange);
		return () => {
			this.listeners.delete(onChange);
		};
	}

	async ensureLoaded(): Promise<AskConfigLoadResult> {
		if (this.config) {
			return { config: this.config, notice: this.notice };
		}
		if (!this.loadPromise) {
			this.loadPromise = this.loadFromDisk();
		}
		const result = await this.loadPromise;
		this.config = result.config;
		this.notice = result.notice;
		this.loadPromise = undefined;
		return result;
	}

	async getConfig(): Promise<AskConfig> {
		return (await this.ensureLoaded()).config;
	}

	async save(config: AskConfig | Partial<AskConfig>): Promise<AskConfig> {
		const normalized = normalizeAskConfig(config);
		const content = JSON.stringify(toAskConfigFile(normalized), null, 2).concat(
			"\n"
		);
		try {
			await mkdir(dirname(this.configPath), { recursive: true });
			await writeFile(this.configPath, content, "utf-8");
		} catch (error) {
			throw createConfigSaveError(this.configPath, error);
		}
		this.setConfig(normalized);
		return normalized;
	}

	setConfig(config: AskConfig): void {
		this.config = normalizeAskConfig(config);
		this.notice = undefined;
		for (const listener of this.listeners) {
			listener(this.config);
		}
	}

	private async loadFromDisk(): Promise<AskConfigLoadResult> {
		const content = await readConfigFileIfPresent(this.configPath);
		if (content === undefined) {
			return this.loadMissingConfig();
		}

		const parsed = parseJson(content);
		if (!parsed.ok || !validateAskConfigFile.Check(parsed.value)) {
			return this.loadDefaultsWithNotice(INVALID_CONFIG_NOTICE);
		}

		return { config: normalizeAskConfig(parsed.value) };
	}

	private async loadMissingConfig(): Promise<AskConfigLoadResult> {
		const config = normalizeAskConfig(DEFAULT_ASK_CONFIG);
		try {
			await this.save(config);
			return { config };
		} catch (saveError) {
			return {
				config,
				notice: {
					kind: "warning",
					text: getErrorMessage(saveError),
				},
			};
		}
	}

	private loadDefaultsWithNotice(text: string): AskConfigLoadResult {
		return {
			config: normalizeAskConfig(DEFAULT_ASK_CONFIG),
			notice: {
				kind: "error",
				text,
			},
		};
	}
}

let askConfigStore: AskConfigStore | undefined;

export function getAskConfigStore(): AskConfigStore {
	askConfigStore ??= new AskConfigStore();
	return askConfigStore;
}

export function resetAskConfigStore(): void {
	askConfigStore = undefined;
}

export function getAskConfigPath(): string {
	return join(getAgentDir(), "extensions", "pi-ask.json");
}

function createConfigSaveError(path: string, error: unknown): Error {
	const detail = getErrorMessage(error);
	return new Error(
		`Unable to save ask config at ${path}. The file may be read-only or managed outside pi-ask; edit it manually and run /reload. ${detail}`
	);
}

function parseJson(
	content: string
): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(content) };
	} catch {
		return { ok: false };
	}
}

async function readConfigFileIfPresent(
	path: string
): Promise<string | undefined> {
	try {
		return await readFile(path, "utf-8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return;
		}
		throw error;
	}
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
	return (
		!!error &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
