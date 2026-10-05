const WEBSOCKET_TIMEOUT_MS = 60_000;

export interface WebSocketCommand {
	type: string;
	[field: string]: unknown;
}

export function runWebSocketCommand(
	upstream: string,
	token: string,
	command: WebSocketCommand,
): Promise<unknown> {
	const url = new URL('/api/websocket', upstream);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		const timeout = setTimeout(
			() => finish(new Error('Timed out')),
			WEBSOCKET_TIMEOUT_MS,
		);

		const finish = (error: Error | undefined, result?: unknown) => {
			clearTimeout(timeout);
			socket.close();
			if (error) reject(error);
			else resolve(result);
		};

		socket.addEventListener('error', () =>
			finish(new Error('Cannot connect to Home Assistant')),
		);
		socket.addEventListener('message', ({ data }) => {
			const message = JSON.parse(String(data));

			if (message.type === 'auth_required') {
				socket.send(JSON.stringify({ type: 'auth', access_token: token }));
			} else if (message.type === 'auth_invalid') {
				finish(new Error('Home Assistant rejected the token'));
			} else if (message.type === 'auth_ok') {
				socket.send(JSON.stringify({ ...command, id: 1 }));
			} else if (message.type === 'result') {
				if (message.success) finish(undefined, message.result);
				else finish(new Error(message.error?.message ?? 'Command failed'));
			}
		});
	});
}
