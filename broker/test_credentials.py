import asyncio
import base64
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from mitmproxy import http
from mitmproxy.test import taddons, tflow
from mitmproxy.websocket import WebSocketData, WebSocketMessage
from wsproto.frame_protocol import Opcode

import mail
from credentials import CredentialBroker, Rule, host_pattern


@pytest.fixture
def secret(tmp_path):
    def write(name: str, value: str) -> str:
        path = tmp_path / name
        path.write_text(f"{value}\n")
        return str(path)

    return write


def make_flow(
    url: str, method: str = "GET", headers: dict | None = None
) -> http.HTTPFlow:
    flow = tflow.tflow()
    flow.request.method = method
    flow.request.url = url
    flow.request.headers.clear()
    flow.request.headers.update(headers or {})
    return flow


def run(broker: CredentialBroker, hook: str, flow: http.HTTPFlow):
    with taddons.context(broker):
        asyncio.run(getattr(broker, hook)(flow))


def test_injects_bearer_and_strips_client_credentials(secret):
    broker = CredentialBroker(
        [
            Rule(
                host="parsify.grafana.net",
                auth={"type": "bearer", "tokenFile": secret("grafana", "glc_real")},
            )
        ]
    )
    flow = make_flow(
        "https://parsify.grafana.net/api/search",
        headers={"authorization": "Bearer placeholder", "cookie": "a=b"},
    )

    run(broker, "request", flow)

    assert flow.request.headers["authorization"] == "Bearer glc_real"
    assert "cookie" not in flow.request.headers


@pytest.mark.parametrize("flatten", [False, True])
def test_signs_enable_banking_jwt(secret, flatten):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    broker = CredentialBroker(
        [
            Rule(
                host="api.enablebanking.com",
                auth={
                    "type": "enable-banking",
                    "applicationIdFile": secret("application-id", "app-123"),
                    "privateKeyFile": secret(
                        "private-key", pem.replace("\n", " ") if flatten else pem
                    ),
                },
            )
        ]
    )
    flow = make_flow(
        "https://api.enablebanking.com/aspsps",
        headers={"authorization": "Bearer placeholder"},
    )

    run(broker, "request", flow)

    scheme, token = flow.request.headers["authorization"].split(" ")
    header, claims, signature = token.split(".")
    private_key.public_key().verify(
        decode_base64url(signature),
        f"{header}.{claims}".encode(),
        padding.PKCS1v15(),
        hashes.SHA256(),
    )
    assert scheme == "Bearer"
    assert json.loads(decode_base64url(header))["kid"] == "app-123"
    assert json.loads(decode_base64url(claims))["aud"] == "api.enablebanking.com"


def test_leaves_unlisted_hosts_untouched(secret):
    broker = CredentialBroker(
        [
            Rule(
                host="api.github.com",
                auth={"type": "bearer", "tokenFile": secret("github", "ghp_real")},
            )
        ]
    )
    flow = make_flow("https://example.com/", headers={"authorization": "Bearer mine"})

    run(broker, "request", flow)

    assert flow.request.headers["authorization"] == "Bearer mine"


def test_injects_basic_auth_for_wildcard_hosts(secret):
    broker = CredentialBroker(
        [
            Rule(
                host="*.icloud.com",
                auth={
                    "type": "basic",
                    "usernameFile": secret("apple-id", "me@example.com"),
                    "passwordFile": secret("apple-password", "app-pass"),
                },
            )
        ]
    )
    flow = make_flow("https://p42-caldav.icloud.com/123/calendars/", method="PROPFIND")

    run(broker, "request", flow)

    expected = base64.b64encode(b"me@example.com:app-pass").decode()
    assert flow.request.headers["authorization"] == f"Basic {expected}"


def test_rejects_methods_outside_the_allowlist(secret):
    broker = CredentialBroker(
        [
            Rule(
                host="10.10.10.1",
                methods=["GET", "POST"],
                auth={"type": "bearer", "tokenFile": secret("token", "real")},
            )
        ]
    )
    flow = make_flow(
        "https://10.10.10.1/proxy/network/api/s/default/rest/device/1", method="PUT"
    )

    run(broker, "request", flow)

    assert flow.response.status_code == 405


def test_replaces_the_home_assistant_websocket_token(secret):
    broker = CredentialBroker(
        [
            Rule(
                host="homeassistant.local",
                auth={"type": "home-assistant", "tokenFile": secret("ha", "ha_real")},
            )
        ]
    )
    flow = make_flow("http://homeassistant.local:8123/api/websocket")
    flow.websocket = WebSocketData()
    flow.websocket.messages.append(
        WebSocketMessage(
            Opcode.TEXT,
            True,
            json.dumps({"type": "auth", "access_token": "placeholder"}).encode(),
        )
    )

    with taddons.context(broker):
        broker.websocket_message(flow)

    assert json.loads(flow.websocket.messages[-1].text) == {
        "type": "auth",
        "access_token": "ha_real",
    }


def test_unifi_logs_in_reuses_the_session_and_logs_in_again_after_401(secret):
    logins = []

    class Controller(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            if self.path == "/api/auth/login":
                assert body == {"username": "wicek", "password": "hunter22"}
                logins.append(1)
                self.send_response(200)
                self.send_header(
                    "set-cookie", f"TOKEN=session-{len(logins)}; Path=/; HttpOnly"
                )
                self.send_header("x-csrf-token", f"csrf-{len(logins)}")
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("x-updated-csrf-token", "rotated")
            self.end_headers()
            self.wfile.write(json.dumps({"cookie": self.headers["cookie"]}).encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Controller)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"

    broker = CredentialBroker(
        [
            Rule(
                host="127.0.0.1",
                auth={
                    "type": "unifi",
                    "usernameFile": secret("unifi-username", "wicek"),
                    "passwordFile": secret("unifi-password", "hunter22"),
                },
            )
        ]
    )

    first = make_flow(f"{origin}/proxy/network/api/s/default/stat/sta", method="POST")
    first.request.content = b"{}"
    run(broker, "request", first)
    assert first.request.headers["cookie"] == "TOKEN=session-1"
    assert first.request.headers["x-csrf-token"] == "csrf-1"

    first.response = http.Response.make(401)
    run(broker, "response", first)
    assert json.loads(first.response.content) == {"cookie": "TOKEN=session-2"}
    assert "x-updated-csrf-token" not in first.response.headers
    assert len(logins) == 2

    second = make_flow(f"{origin}/proxy/network/api/s/default/stat/device")
    run(broker, "request", second)
    assert second.request.headers["x-csrf-token"] == "rotated"
    assert len(logins) == 2
    server.shutdown()


def test_host_pattern_matches_wildcards_with_ports():
    pattern = re.compile(host_pattern("*.icloud.com"))
    assert pattern.match("p42-caldav.icloud.com:443")
    assert not pattern.match("icloud.com.evil.example:443")


def test_streams_server_sent_events_and_strips_headers_up_front(secret):
    broker = CredentialBroker(
        [
            Rule(
                host="homeassistant.local",
                auth={"type": "home-assistant", "tokenFile": secret("ha-sse", "real")},
            )
        ]
    )
    flow = make_flow("http://homeassistant.local:8123/mcp_server/sse")
    flow.response = http.Response.make(
        200, b"", {"content-type": "text/event-stream", "set-cookie": "a=b"}
    )

    with taddons.context(broker):
        broker.responseheaders(flow)

    assert flow.response.stream is True
    assert "set-cookie" not in flow.response.headers


def test_answers_imap_hosts_from_the_mail_gateway(secret, monkeypatch):
    calls = []

    def respond(request, server, username, password):
        calls.append((request.path, server, username, password))
        return http.Response.make(200, b"{}")

    monkeypatch.setattr(mail, "respond", respond)
    broker = CredentialBroker(
        [
            Rule(
                host="imap.broker",
                methods=["GET"],
                auth={
                    "type": "imap",
                    "server": "imap.mail.me.com",
                    "usernameFile": secret("mail-username", "me@icloud.com"),
                    "passwordFile": secret("mail-password", "app-pass"),
                },
            )
        ]
    )
    read = make_flow("http://imap.broker/search?from=alice")
    write = make_flow("http://imap.broker/message?uid=1", method="DELETE")

    run(broker, "request", read)
    run(broker, "request", write)

    assert read.response.status_code == 200
    assert calls == [
        ("/search?from=alice", "imap.mail.me.com", "me@icloud.com", "app-pass")
    ]
    assert write.response.status_code == 405


def decode_base64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
