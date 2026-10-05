import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	alertKey,
	describeAlert,
	type GrafanaAlert,
	partitionAlerts,
	verifyGrafanaAuthorization,
} from './grafana.ts';

const firing: GrafanaAlert = {
	status: 'firing',
	labels: {
		alertname: 'PodCrashLoopBackOff',
		namespace: 'wicek',
		grafana_folder: 'Cluster Alerts',
		__alert_rule_uid__: 'abc',
	},
	annotations: { summary: 'wicek is crash looping' },
	startsAt: '2026-10-05T01:02:03Z',
	fingerprint: 'f1',
};

test('accepts only the exact bearer token', () => {
	assert.equal(verifyGrafanaAuthorization('token', 'Bearer token'), true);
	assert.equal(verifyGrafanaAuthorization('token', 'Bearer other'), false);
	assert.equal(verifyGrafanaAuthorization('token', 'token'), false);
	assert.equal(verifyGrafanaAuthorization('token', undefined), false);
});

test('splits firing and resolved alerts', () => {
	const resolved: GrafanaAlert = {
		...firing,
		status: 'resolved',
		fingerprint: 'f2',
	};
	assert.deepEqual(partitionAlerts({ alerts: [firing, resolved] }), {
		firing: [firing],
		resolved: [resolved],
	});
	assert.deepEqual(partitionAlerts({}), { firing: [], resolved: [] });
});

test('keys alerts by fingerprint and start time so a re-fire is new', () => {
	assert.equal(alertKey(firing), 'f1@2026-10-05T01:02:03Z');
	assert.notEqual(
		alertKey(firing),
		alertKey({ ...firing, startsAt: '2026-10-05T05:00:00Z' }),
	);
});

test('describes an alert without internal labels', () => {
	assert.equal(
		describeAlert(firing),
		'PodCrashLoopBackOff {namespace=wicek} – wicek is crash looping – since 2026-10-05T01:02:03Z',
	);
});
