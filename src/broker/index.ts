import { getOptionalEnv } from '../utils/env.ts';
import logger from '../utils/logger.ts';
import { loadRoutes } from './config.ts';
import { createRouteServer } from './proxy.ts';

const LISTEN_HOST = '127.0.0.1';
const DEFAULT_CONFIG_PATH = '/etc/broker/routes.json';

const routes = loadRoutes(
	getOptionalEnv('BROKER_CONFIG') ?? DEFAULT_CONFIG_PATH,
);

for (const route of routes) {
	createRouteServer(route).listen(route.port, LISTEN_HOST, () =>
		logger.info(
			{ route: route.name, port: route.port, upstream: route.upstream },
			'Broker route listening',
		),
	);
}
