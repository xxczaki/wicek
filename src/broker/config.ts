import { readFileSync } from 'node:fs';

export interface BearerAuth {
	type: 'bearer' | 'home-assistant';
	tokenFile: string;
}

export interface UnifiAuth {
	type: 'unifi';
	usernameFile: string;
	passwordFile: string;
}

export interface Route {
	name: string;
	port: number;
	upstream: string;
	auth: BearerAuth | UnifiAuth;
	methods?: string[];
	insecureTls?: boolean;
}

export function loadRoutes(path: string): Route[] {
	const { routes } = JSON.parse(readFileSync(path, 'utf8')) as {
		routes: Route[];
	};

	for (const route of routes) {
		const upstream = new URL(route.upstream);
		if (upstream.pathname !== '/' || upstream.search) {
			throw new Error(`Route ${route.name}: upstream must be an origin`);
		}
	}

	return routes;
}

export function readSecret(path: string): string {
	return readFileSync(path, 'utf8').trim();
}
