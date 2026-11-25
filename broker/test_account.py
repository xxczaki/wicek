import asyncio
from types import SimpleNamespace

from mitmproxy.test import tflow

import account
import browser
import credentials
from test_logins import AUTH

GATEWAY_PORT = 3128
BROWSER_PORT = 3129


def flow_on(port: int, url: str):
    flow = tflow.tflow()
    flow.client_conn.sockname = ("127.0.0.1", port)
    flow.request.url = url
    return flow


def run(result):
    if asyncio.iscoroutine(result):
        return asyncio.run(result)
    return result


def gateway():
    broker = credentials.CredentialBroker([], block_unlisted=True)
    return account.OnPort(broker, GATEWAY_PORT)


def test_gateway_blocks_unlisted_hosts_on_its_port():
    flow = flow_on(GATEWAY_PORT, "https://example.com/")
    run(gateway().request(flow))
    assert flow.response.status_code == 403


def test_gateway_ignores_browser_traffic():
    flow = flow_on(BROWSER_PORT, "https://example.com/")
    run(gateway().request(flow))
    assert flow.response is None


def test_gateway_ignores_browser_connects():
    flow = flow_on(BROWSER_PORT, "https://example.com/")
    gateway().http_connect(flow)
    assert flow.response is None


def test_browser_fill_is_not_served_on_the_gateway_port():
    addon = account.OnPort(browser.BrowserLogins(AUTH), BROWSER_PORT)
    flow = flow_on(GATEWAY_PORT, "http://logins.broker/fill")
    flow.request.method = "POST"
    run(addon.request(flow))
    assert flow.response is None


def test_scoped_addons_get_unique_names():
    names = {
        gateway().name,
        account.OnPort(browser.BrowserLogins(AUTH), BROWSER_PORT).name,
    }
    assert len(names) == 2


def test_tls_hook_only_runs_for_its_port():
    calls = []
    addon = account.OnPort(SimpleNamespace(tls_start_server=calls.append), GATEWAY_PORT)
    for port in (GATEWAY_PORT, BROWSER_PORT):
        client = SimpleNamespace(sockname=("127.0.0.1", port))
        addon.tls_start_server(SimpleNamespace(context=SimpleNamespace(client=client)))
    assert len(calls) == 1
