import asyncio
import json
import os
import subprocess

from mitmproxy import http

import logins
import mail

CONFIG_PATH = os.environ.get("BROKER_CONFIG", "/etc/broker/config.json")
FILL_HOST = "logins.broker"
FILL_PATH = "/fill"
EXTENSION_ORIGIN = "chrome-extension://eajfecbeimkiabplgnijkincnflnapmd"


class BrowserLogins:
    def __init__(self, auth: dict):
        self.auth = auth

    async def request(self, flow: http.HTTPFlow):
        if flow.request.pretty_host == FILL_HOST:
            flow.response = await asyncio.to_thread(fill, flow.request, self.auth)
            return
        await asyncio.to_thread(logins.fill_placeholders, flow.request, self.auth)


def fill(request: http.Request, auth: dict) -> http.Response:
    if request.path.split("?")[0] != FILL_PATH or request.method != "POST":
        return mail.json_response(404, {"error": "Not found"})
    if request.headers.get("origin") != EXTENSION_ORIGIN:
        return mail.json_response(403, {"error": "Only the fill extension may ask"})
    try:
        body = json.loads(request.get_text() or "{}")
        value = logins.fill_value(
            auth, str(body.get("placeholder", "")), str(body.get("url", ""))
        )
        return mail.json_response(200, {"value": value})
    except json.JSONDecodeError:
        return mail.json_response(400, {"error": "Expected a JSON body"})
    except logins.LoginError as error:
        return mail.json_response(error.status, {"error": str(error)})
    except (OSError, subprocess.SubprocessError) as error:
        return mail.json_response(502, {"error": f"Lookup failed: {error}"})


def logins_auth(path: str) -> dict | None:
    with open(path) as config_file:
        hosts = json.load(config_file)["hosts"]
    return next(
        (entry["auth"] for entry in hosts if entry["auth"]["type"] == "logins"), None
    )


auth = logins_auth(CONFIG_PATH) if os.path.exists(CONFIG_PATH) else None
addons = [BrowserLogins(auth)] if auth else []
