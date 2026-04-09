const cache = new Map<string, string>();

export function getEnv(key: string): string {
	const cached = cache.get(key);
	if (cached) return cached;

	const value = process.env[key];
	if (!value) {
		throw new Error(`Missing required environment variable: ${key}`);
	}

	cache.set(key, value);
	return value;
}

export function getEnvList(key: string): string[] {
	return getEnv(key)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

export function getOptionalEnv(key: string): string | undefined {
	return process.env[key] || undefined;
}
