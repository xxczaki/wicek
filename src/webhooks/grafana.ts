import { createHash, timingSafeEqual } from 'node:crypto';

const HIDDEN_LABELS = new Set(['alertname', 'grafana_folder']);

export interface GrafanaAlert {
	status: 'firing' | 'resolved';
	labels: Record<string, string>;
	annotations?: Record<string, string>;
	startsAt: string;
	fingerprint: string;
}

export interface GrafanaPayload {
	alerts?: GrafanaAlert[];
}

export function verifyGrafanaAuthorization(
	token: string,
	authorization: string | undefined,
): boolean {
	return timingSafeEqual(
		sha256(`Bearer ${token}`),
		sha256(authorization ?? ''),
	);
}

export function partitionAlerts(payload: GrafanaPayload) {
	const alerts = payload.alerts ?? [];
	return {
		firing: alerts.filter((alert) => alert.status === 'firing'),
		resolved: alerts.filter((alert) => alert.status === 'resolved'),
	};
}

export function alertKey(alert: GrafanaAlert): string {
	return `${alert.fingerprint}@${alert.startsAt}`;
}

export function describeAlert(alert: GrafanaAlert): string {
	const labels = Object.entries(alert.labels)
		.filter(([name]) => !HIDDEN_LABELS.has(name) && !name.startsWith('__'))
		.map(([name, value]) => `${name}=${value}`)
		.join(', ');
	const summary =
		alert.annotations?.summary ?? alert.annotations?.description ?? '';
	return [
		`${alert.labels.alertname ?? 'unknown alert'}${labels ? ` {${labels}}` : ''}`,
		summary,
		`since ${alert.startsAt}`,
	]
		.filter(Boolean)
		.join(' – ');
}

export function buildGrafanaPrompt(lines: string[]): string {
	return [
		'Use the infrastructure subagent to triage these newly firing Grafana Cloud alerts:',
		...lines.map((line) => `- ${line}`),
		'',
		'Investigate before concluding, read-only:',
		'1. Alert state history in Grafana Cloud (https://parsify.grafana.net) – when it started, whether it flaps, related alerts.',
		'2. Cluster health over SSH to the Raspberry Pi – node status, pods not Running/Ready, recent warning events, ArgoCD app sync/health.',
		'3. Alloy (k8s-monitoring) logs for remote-write or scrape errors – a telemetry gap can look like an outage.',
		'4. UniFi WAN stats (https://10.10.10.1) for internet drops – the home connection drops nightly around 03:00–04:00 and 06:00 CEST.',
		'Do not change cluster, network, or Grafana config. Report the likely cause, key evidence, and whether action is needed (and what), Discord-formatted, under 1500 characters.',
	].join('\n');
}

function sha256(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}
