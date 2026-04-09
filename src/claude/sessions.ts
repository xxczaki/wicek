import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOptionalEnv } from '../utils/env.ts';
import logger from '../utils/logger.ts';

interface SessionEntry {
	sessionId: string;
	lastUsed: number;
}

const sessions = new Map<string, SessionEntry>();
let loaded = false;

function filePath(): string {
	const dataDir = getOptionalEnv('DATA_DIR') || '/data';
	return join(dataDir, 'sessions.json');
}

function load() {
	if (loaded) return;
	loaded = true;

	try {
		const raw = readFileSync(filePath(), 'utf-8');
		const entries = JSON.parse(raw) as Record<string, SessionEntry>;
		for (const [key, entry] of Object.entries(entries)) {
			sessions.set(key, entry);
		}
		logger.info({ count: sessions.size }, 'Loaded session mappings');
	} catch {
		// File doesn't exist yet — that's fine
	}
}

function save() {
	const obj: Record<string, SessionEntry> = {};
	for (const [key, entry] of sessions) {
		obj[key] = entry;
	}

	const tmp = `${filePath()}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(obj, null, 2));
		renameSync(tmp, filePath());
	} catch (error) {
		logger.error({ error }, 'Failed to save session mappings');
	}
}

export function contextKey(options: {
	isDM: boolean;
	userId: string;
	threadId?: string;
	channelId: string;
}): string {
	if (options.isDM) return `dm:${options.userId}`;
	if (options.threadId) return `thread:${options.threadId}`;
	return `channel:${options.channelId}`;
}

export function getSession(key: string): string | undefined {
	load();
	return sessions.get(key)?.sessionId;
}

export function setSession(key: string, sessionId: string) {
	load();
	sessions.set(key, { sessionId, lastUsed: Date.now() });
	save();
}

export function clearSession(key: string) {
	load();
	sessions.delete(key);
	save();
}

export function flushSessions() {
	if (loaded) save();
}
