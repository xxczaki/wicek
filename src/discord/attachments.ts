import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Attachment, Collection } from 'discord.js';
import { getOptionalEnv } from '../utils/env.ts';
import logger from '../utils/logger.ts';

const ATTACHMENTS_DIR = join(
	getOptionalEnv('DATA_DIR') || '/data',
	'attachments',
);

async function downloadAttachment(attachment: Attachment): Promise<string> {
	mkdirSync(ATTACHMENTS_DIR, { recursive: true });
	const filename = `${attachment.id}-${attachment.name}`;
	const filepath = join(ATTACHMENTS_DIR, filename);

	const response = await fetch(attachment.url);
	if (!response.ok || !response.body) {
		throw new Error(
			`Failed to download ${attachment.name}: ${response.status}`,
		);
	}

	await pipeline(Readable.fromWeb(response.body), createWriteStream(filepath));
	return filepath;
}

export async function downloadAttachments(
	attachments: Collection<string, Attachment>,
): Promise<string[]> {
	const paths: string[] = [];

	for (const attachment of attachments.values()) {
		try {
			const path = await downloadAttachment(attachment);
			paths.push(path);
			logger.info({ name: attachment.name, path }, 'Attachment downloaded');
		} catch (error) {
			logger.error(
				{ error, name: attachment.name },
				'Attachment download failed',
			);
		}
	}

	return paths;
}

export function buildPromptWithAttachments(
	text: string,
	paths: string[],
): string {
	if (paths.length === 0) return text;

	const fileRefs = paths.map((p) => `[Attached file: ${p}]`).join('\n');
	return `${text}\n\n${fileRefs}`;
}
