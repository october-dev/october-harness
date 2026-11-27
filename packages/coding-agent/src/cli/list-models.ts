/**
 * List available models with optional fuzzy search
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { getNoModelsGuidance } from "../core/auth-guidance.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { isFreeOctoberOpenRouterModel, modelAccountLabel, octoberModelBadge } from "../extensions/october/pricing.ts";

/**
 * Format a number as human-readable (e.g., 200000 -> "200K", 1000000 -> "1M")
 */
function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

/**
 * List available models, optionally filtered by search pattern
 */
export async function listModels(
	modelRuntime: ModelRuntime,
	searchPattern?: string,
	signal?: AbortSignal,
): Promise<void> {
	let models: Model<Api>[];
	try {
		models = [...(await modelRuntime.getAvailable(undefined, { signal }))];
	} catch (error) {
		if (!signal?.aborted) throw error;
		// A slow auth check must not hang or fail a metadata command; list what is already known.
		console.error(chalk.yellow("Warning: model availability check timed out; showing the last known models."));
		models = [...modelRuntime.getAvailableSnapshot()];
	}

	if (models.length === 0) {
		console.log(getNoModelsGuidance(modelRuntime, "shell").message);
		return;
	}

	// Apply fuzzy filter if search pattern provided
	let filteredModels: Model<Api>[] = models;
	if (searchPattern) {
		filteredModels = fuzzyFilter(models, searchPattern, (m) => `${m.provider} ${m.id}`);
	}

	if (filteredModels.length === 0) {
		console.log(`No models matching "${searchPattern}"`);
		return;
	}

	// Group free October OpenRouter routes first, then keep the provider and ID ordering.
	filteredModels.sort((a, b) => {
		const freeOrder = Number(isFreeOctoberOpenRouterModel(b)) - Number(isFreeOctoberOpenRouterModel(a));
		if (freeOrder !== 0) return freeOrder;
		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;
		return a.id.localeCompare(b.id);
	});

	// Calculate column widths
	const rows = filteredModels.map((m) => ({
		provider: m.provider,
		model: m.id,
		context: formatTokenCount(m.contextWindow),
		maxOut: formatTokenCount(m.maxTokens),
		thinking: m.reasoning ? "yes" : "no",
		images: m.input.includes("image") ? "yes" : "no",
		price: isFreeOctoberOpenRouterModel(m) ? "FREE" : octoberModelBadge(m),
		account: modelAccountLabel(m),
	}));
	const showAccount = rows.some((row) => row.account);
	const showPrice = rows.some((row) => row.price);

	const headers = {
		provider: "provider",
		model: "model",
		context: "context",
		maxOut: "max-out",
		thinking: "thinking",
		images: "images",
		price: "price",
	};

	const widths = {
		provider: Math.max(headers.provider.length, ...rows.map((r) => r.provider.length)),
		model: Math.max(headers.model.length, ...rows.map((r) => r.model.length)),
		context: Math.max(headers.context.length, ...rows.map((r) => r.context.length)),
		maxOut: Math.max(headers.maxOut.length, ...rows.map((r) => r.maxOut.length)),
		thinking: Math.max(headers.thinking.length, ...rows.map((r) => r.thinking.length)),
		images: Math.max(headers.images.length, ...rows.map((r) => r.images.length)),
		price: Math.max(headers.price.length, ...rows.map((r) => r.price?.length ?? 0)),
	};

	// Print header
	const headerLine = [
		headers.provider.padEnd(widths.provider),
		headers.model.padEnd(widths.model),
		headers.context.padEnd(widths.context),
		headers.maxOut.padEnd(widths.maxOut),
		headers.thinking.padEnd(widths.thinking),
		headers.images.padEnd(widths.images),
		...(showPrice ? [headers.price.padEnd(widths.price)] : []),
		...(showAccount ? ["account"] : []),
	].join("  ");
	console.log(headerLine);

	// Print rows
	for (const row of rows) {
		const line = [
			row.provider.padEnd(widths.provider),
			row.model.padEnd(widths.model),
			row.context.padEnd(widths.context),
			row.maxOut.padEnd(widths.maxOut),
			row.thinking.padEnd(widths.thinking),
			row.images.padEnd(widths.images),
			...(showPrice ? [(row.price ?? "").padEnd(widths.price)] : []),
			...(row.account ? [row.account] : []),
		].join("  ");
		console.log(line);
	}
}
