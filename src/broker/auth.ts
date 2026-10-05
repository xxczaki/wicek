import type { IncomingMessage } from 'node:http';
import { type Route, readSecret, type UnifiAuth } from './config.ts';
import { readBody, requestUpstream } from './upstream.ts';

const MAX_LOGIN_RESPONSE_BYTES = 64 * 1024;

export interface Authenticator {
	headers(): Promise<Record<string, string>>;
	refresh?(): Promise<void>;
	observe?(response: IncomingMessage): void;
}

export function createAuthenticator(route: Route): Authenticator {
	const { auth } = route;
	if (auth.type === 'unifi') return unifiAuthenticator(route, auth);

	return {
		headers: async () => ({
			authorization: `Bearer ${readSecret(auth.tokenFile)}`,
		}),
	};
}

interface UnifiSession {
	cookie: string;
	csrfToken: string;
}

function unifiAuthenticator(route: Route, auth: UnifiAuth): Authenticator {
	let session: Promise<UnifiSession> | undefined;

	const login = () => {
		session = loginToUnifi(route, auth);
		session.catch(() => {
			session = undefined;
		});
		return session;
	};

	return {
		async headers() {
			const { cookie, csrfToken } = await (session ?? login());
			return { cookie, 'x-csrf-token': csrfToken };
		},
		async refresh() {
			await login();
		},
		observe(response) {
			const updatedToken = response.headers['x-updated-csrf-token'];
			if (session && typeof updatedToken === 'string') {
				session = session.then((current) => ({
					...current,
					csrfToken: updatedToken,
				}));
			}
		},
	};
}

async function loginToUnifi(
	route: Route,
	auth: UnifiAuth,
): Promise<UnifiSession> {
	const response = await requestUpstream(route, {
		method: 'POST',
		path: '/api/auth/login',
		headers: { 'content-type': 'application/json' },
		body: Buffer.from(
			JSON.stringify({
				username: readSecret(auth.usernameFile),
				password: readSecret(auth.passwordFile),
			}),
		),
	});
	await readBody(response, MAX_LOGIN_RESPONSE_BYTES);

	const tokenCookie = response.headers['set-cookie']
		?.map((cookie) => cookie.split(';')[0])
		.find((cookie) => cookie.startsWith('TOKEN='));
	const csrfToken = response.headers['x-csrf-token'];

	if (response.statusCode !== 200 || !tokenCookie || !csrfToken) {
		throw new Error(`UniFi login failed with status ${response.statusCode}`);
	}

	return { cookie: tokenCookie, csrfToken: String(csrfToken) };
}
