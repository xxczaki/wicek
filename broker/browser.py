import asyncio
import json
import os

from mitmproxy import http

import logins

CONFIG_PATH = os.environ.get("BROKER_CONFIG", "/etc/broker/config.json")


class BrowserLogins:
    def __init__(self, auth: dict):
        self.auth = auth

    async def request(self, flow: http.HTTPFlow):
        await asyncio.to_thread(logins.fill_placeholders, flow.request, self.auth)


def logins_auth(path: str) -> dict | None:
    with open(path) as config_file:
        hosts = json.load(config_file)["hosts"]
    return next(
        (entry["auth"] for entry in hosts if entry["auth"]["type"] == "logins"), None
    )


auth = logins_auth(CONFIG_PATH) if os.path.exists(CONFIG_PATH) else None
addons = [BrowserLogins(auth)] if auth else []
