import json

import pytest
from mitmproxy.test import tflow

import browser
import logins
from test_logins import AUTH, ITEM

EXTENSION_ORIGIN = browser.EXTENSION_ORIGIN


@pytest.fixture(autouse=True)
def one_password(monkeypatch):
    monkeypatch.setattr(logins, "run_op", lambda auth, *args: ITEM)


def fill_request(body: dict, origin: str = EXTENSION_ORIGIN, method: str = "POST"):
    flow = tflow.tflow()
    flow.request.method = method
    flow.request.url = "http://logins.broker/fill"
    flow.request.headers.clear()
    flow.request.headers["content-type"] = "application/json"
    if origin:
        flow.request.headers["origin"] = origin
    flow.request.content = json.dumps(body).encode()
    return flow.request


def answer(request):
    response = browser.fill(request, AUTH)
    return response.status_code, json.loads(response.get_text())


@pytest.mark.parametrize(
    ("placeholder", "expected"),
    [
        ("WICEK_LOGIN_abc123_PASSWORD", 'p&ss "w"'),
        ("wicek_login_ABC123_username@wicek.invalid", "me@example.com"),
    ],
)
def test_fills_on_the_items_domains(placeholder, expected):
    request = fill_request(
        {"placeholder": placeholder, "url": "https://www.check24.de/login"}
    )
    assert answer(request) == (200, {"value": expected})


@pytest.mark.parametrize(
    "url",
    ["https://evil.example/login", "http://www.check24.de/login", "chrome://x"],
)
def test_refuses_other_pages(url):
    request = fill_request({"placeholder": "WICEK_LOGIN_abc123_PASSWORD", "url": url})
    assert answer(request)[0] == 403


@pytest.mark.parametrize("origin", ["https://www.check24.de", "null", ""])
def test_refuses_anyone_but_the_extension(origin):
    request = fill_request(
        {"placeholder": "WICEK_LOGIN_abc123_PASSWORD", "url": "https://check24.de/"},
        origin=origin,
    )
    assert answer(request)[0] == 403


def test_refuses_partial_placeholders():
    request = fill_request(
        {"placeholder": "WICEK_LOGIN_abc123_USERNAME", "url": "https://check24.de/"}
    )
    assert answer(request)[0] == 400


def test_only_accepts_posts():
    request = fill_request({}, method="GET")
    assert answer(request)[0] == 404
