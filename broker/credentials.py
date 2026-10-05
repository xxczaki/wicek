import asyncio
import base64
import fnmatch
import json
import os
import re
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass, field

from mitmproxy import ctx, http, tls
from OpenSSL import SSL

CONFIG_PATH = os.environ.get("BROKER_CONFIG", "/etc/broker/config.json")
LOGIN_TIMEOUT_SECONDS = 15

STRIPPED_REQUEST_HEADERS = (
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-api-key",
    "x-csrf-token",
)
STRIPPED_RESPONSE_HEADERS = ("set-cookie", "x-csrf-token", "x-updated-csrf-token")


@dataclass
class UnifiSession:
    cookie: str
    csrf_token: str


@dataclass
class Rule:
    host: str
    auth: dict
    methods: list[str] | None = None
    insecure_tls: bool = False
    unifi_session: UnifiSession | None = field(default=None, repr=False)

    def matches(self, hostname: str) -> bool:
        return fnmatch.fnmatchcase(hostname.lower(), self.host.lower())


class CredentialBroker:
    def __init__(self, rules: list[Rule]):
        self.rules = rules
        self.login_lock = asyncio.Lock()

    @classmethod
    def from_file(cls, path: str) -> "CredentialBroker":
        with open(path) as config_file:
            config = json.load(config_file)
        return cls(
            [
                Rule(
                    host=entry["host"],
                    auth=entry["auth"],
                    methods=entry.get("methods"),
                    insecure_tls=entry.get("insecureTls", False),
                )
                for entry in config["hosts"]
            ]
        )

    def running(self):
        ctx.options.update(allow_hosts=[host_pattern(rule.host) for rule in self.rules])

    def rule_for(self, hostname: str | None) -> Rule | None:
        if not hostname:
            return None
        return next((rule for rule in self.rules if rule.matches(hostname)), None)

    def tls_start_server(self, data: tls.TlsData):
        server = data.context.server
        rule = self.rule_for(
            server.sni or (server.address[0] if server.address else None)
        )
        if rule and rule.insecure_tls and data.ssl_conn is None:
            ctx.master.addons.get("tlsconfig").tls_start_server(data)
            data.ssl_conn.set_verify(SSL.VERIFY_NONE, None)

    async def request(self, flow: http.HTTPFlow):
        rule = self.rule_for(flow.request.pretty_host)
        if not rule:
            return

        if rule.methods and flow.request.method not in rule.methods:
            flow.response = http.Response.make(
                405,
                json.dumps(
                    {"error": f"{flow.request.method} is not allowed on {rule.host}"}
                ),
                {"content-type": "application/json"},
            )
            return

        for name in STRIPPED_REQUEST_HEADERS:
            flow.request.headers.pop(name, None)
        flow.request.headers.update(await self.auth_headers(rule, flow))

    def responseheaders(self, flow: http.HTTPFlow):
        rule = self.rule_for(flow.request.pretty_host)
        if not rule or not flow.response:
            return

        content_type = flow.response.headers.get("content-type", "")
        if content_type.startswith("text/event-stream"):
            flow.response.stream = True
        if flow.response.status_code != 401:
            self.finish_response(rule, flow.response)

    async def response(self, flow: http.HTTPFlow):
        rule = self.rule_for(flow.request.pretty_host)
        if not rule or not flow.response:
            return

        if rule.auth["type"] == "unifi" and flow.response.status_code == 401:
            rule.unifi_session = None
            flow.request.headers.update(await self.auth_headers(rule, flow))
            flow.response = await asyncio.to_thread(send_directly, rule, flow.request)
        self.finish_response(rule, flow.response)

        path = flow.request.path.split("?")[0]
        status = flow.response.status_code
        host = flow.request.pretty_host
        ctx.log.info(f"broker {host} {flow.request.method} {path} {status}")

    def finish_response(self, rule: Rule, response: http.Response):
        updated_token = response.headers.get("x-updated-csrf-token")
        if rule.auth["type"] == "unifi" and updated_token and rule.unifi_session:
            rule.unifi_session.csrf_token = updated_token
        for name in STRIPPED_RESPONSE_HEADERS:
            response.headers.pop(name, None)

    def websocket_message(self, flow: http.HTTPFlow):
        rule = self.rule_for(flow.request.pretty_host)
        if not rule or rule.auth["type"] != "home-assistant" or not flow.websocket:
            return

        message = flow.websocket.messages[-1]
        if not message.from_client or not message.is_text:
            return
        try:
            payload = json.loads(message.text)
        except ValueError:
            return
        if isinstance(payload, dict) and payload.get("type") == "auth":
            payload["access_token"] = read_secret(rule.auth["tokenFile"])
            message.text = json.dumps(payload)

    async def auth_headers(self, rule: Rule, flow: http.HTTPFlow) -> dict[str, str]:
        auth = rule.auth
        if auth["type"] in ("bearer", "home-assistant"):
            return {"authorization": f"Bearer {read_secret(auth['tokenFile'])}"}
        if auth["type"] == "basic":
            username = auth.get("username") or read_secret(auth["usernameFile"])
            password = read_secret(auth["passwordFile"])
            encoded = base64.b64encode(f"{username}:{password}".encode()).decode()
            return {"authorization": f"Basic {encoded}"}
        if auth["type"] == "unifi":
            async with self.login_lock:
                if not rule.unifi_session:
                    origin = f"{flow.request.scheme}://{flow.request.host}:{flow.request.port}"
                    rule.unifi_session = await asyncio.to_thread(
                        login_to_unifi, rule, origin
                    )
            return {
                "cookie": rule.unifi_session.cookie,
                "x-csrf-token": rule.unifi_session.csrf_token,
            }
        raise ValueError(f"Unknown auth type {auth['type']}")


def host_pattern(host: str) -> str:
    return "^" + re.escape(host.lower()).replace(r"\*", "[^:]*") + r"(:\d+)?$"


def read_secret(path: str) -> str:
    with open(path) as secret_file:
        return secret_file.read().strip()


def tls_context(rule: Rule) -> ssl.SSLContext:
    context = ssl.create_default_context()
    if rule.insecure_tls:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


def login_to_unifi(rule: Rule, origin: str) -> UnifiSession:
    body = json.dumps(
        {
            "username": read_secret(rule.auth["usernameFile"]),
            "password": read_secret(rule.auth["passwordFile"]),
        }
    ).encode()
    request = urllib.request.Request(
        f"{origin}/api/auth/login",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(
        request, context=tls_context(rule), timeout=LOGIN_TIMEOUT_SECONDS
    ) as response:
        cookies = response.headers.get_all("set-cookie") or []
        token_cookie = next(
            (cookie.split(";")[0] for cookie in cookies if cookie.startswith("TOKEN=")),
            None,
        )
        csrf_token = response.headers.get("x-csrf-token")
    if not token_cookie or not csrf_token:
        raise RuntimeError("UniFi login did not return a session")
    return UnifiSession(cookie=token_cookie, csrf_token=csrf_token)


def send_directly(rule: Rule, request: http.Request) -> http.Response:
    outgoing = urllib.request.Request(
        request.url,
        data=request.raw_content or None,
        headers={
            name: value
            for name, value in request.headers.items()
            if name.lower() != "host"
        },
        method=request.method,
    )
    try:
        with urllib.request.urlopen(
            outgoing, context=tls_context(rule), timeout=LOGIN_TIMEOUT_SECONDS
        ) as response:
            return http.Response.make(
                response.status, response.read(), forwardable(response.headers)
            )
    except urllib.error.HTTPError as error:
        return http.Response.make(error.code, error.read(), forwardable(error.headers))


def forwardable(headers) -> dict[str, str]:
    return {
        name: value
        for name, value in headers.items()
        if name.lower() not in ("connection", "content-length", "transfer-encoding")
    }


addons = (
    [CredentialBroker.from_file(CONFIG_PATH)] if os.path.exists(CONFIG_PATH) else []
)
