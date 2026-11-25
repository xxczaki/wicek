import os

import browser
import credentials

GATEWAY_PORT = int(os.environ.get("BROKER_PORT", "3128"))
BROWSER_PORT = int(os.environ.get("BROKER_BROWSER_PORT", "3129"))
FLOW_HOOKS = (
    "http_connect",
    "request",
    "responseheaders",
    "response",
    "websocket_message",
)


class OnPort:
    def __init__(self, addon, port: int):
        self.addon = addon
        self.port = port
        self.name = f"{type(addon).__name__.lower()}-{port}"
        for hook in FLOW_HOOKS:
            handler = getattr(addon, hook, None)
            if handler:
                setattr(self, hook, self.scoped(handler))

    def scoped(self, handler):
        def run(flow):
            if listener_port(flow.client_conn) == self.port:
                return handler(flow)

        return run

    def tls_start_server(self, data):
        handler = getattr(self.addon, "tls_start_server", None)
        if handler and listener_port(data.context.client) == self.port:
            handler(data)


def listener_port(client) -> int | None:
    return client.sockname[1] if client.sockname else None


addons = [OnPort(addon, GATEWAY_PORT) for addon in credentials.addons] + [
    OnPort(addon, BROWSER_PORT) for addon in browser.addons
]
