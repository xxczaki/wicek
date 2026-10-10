from datetime import UTC, datetime, timedelta

import pytest
from mitmproxy.test import tflow

import logins
import mail

ITEM = {
    "id": "abc123",
    "title": "Check24",
    "urls": [{"href": "https://www.check24.de/login"}, {"href": "check24.com"}],
    "fields": [
        {"purpose": "USERNAME", "value": "me@example.com"},
        {"purpose": "PASSWORD", "value": 'p&ss "w"'},
    ],
}
AUTH = {
    "vault": "Wicek Logins",
    "tokenFile": "/unused",
    "mailServer": "imap.example.com",
    "mailUsernameFile": "/unused",
    "mailPasswordFile": "/unused",
}


@pytest.fixture(autouse=True)
def one_password(monkeypatch):
    calls = []

    def run_op(auth, *args):
        calls.append(args)
        return [ITEM] if args[:2] == ("item", "list") else ITEM

    monkeypatch.setattr(logins, "run_op", run_op)
    return calls


def login_request(host: str, content_type: str, body: bytes):
    flow = tflow.tflow()
    flow.request.method = "POST"
    flow.request.url = f"https://{host}/session"
    flow.request.headers.clear()
    flow.request.headers["content-type"] = content_type
    flow.request.content = body
    return flow.request


@pytest.mark.parametrize(
    ("content_type", "body", "expected"),
    [
        (
            "application/x-www-form-urlencoded",
            b"u=WICEK_LOGIN_abc123_USERNAME%40wicek.invalid&p=WICEK_LOGIN_abc123_PASSWORD",
            b"u=me%40example.com&p=p%26ss+%22w%22",
        ),
        (
            "application/json",
            b'{"u":"wicek_login_abc123_username@wicek.invalid","p":"WICEK_LOGIN_abc123_PASSWORD"}',
            b'{"u":"me@example.com","p":"p&ss \\"w\\""}',
        ),
    ],
)
def test_fills_placeholders_on_the_items_domains(content_type, body, expected):
    request = login_request("accounts.check24.com", content_type, body)

    logins.fill_placeholders(request, AUTH)

    assert request.content == expected


def test_leaves_placeholders_for_other_domains(one_password):
    body = b"p=WICEK_LOGIN_abc123_PASSWORD"
    request = login_request(
        "check24.de.evil.example", "application/x-www-form-urlencoded", body
    )
    unrelated = login_request("example.com", "text/plain", b"hello")

    logins.fill_placeholders(request, AUTH)
    logins.fill_placeholders(unrelated, AUTH)

    assert request.content == body
    assert one_password == [("item", "get", "abc123")]


def test_lists_logins_without_values():
    [login] = logins.list_logins(AUTH)

    assert login == {
        "item": "abc123",
        "title": "Check24",
        "domains": ["check24.com", "check24.de"],
        "placeholders": {
            "username": "WICEK_LOGIN_abc123_USERNAME@wicek.invalid",
            "password": "WICEK_LOGIN_abc123_PASSWORD",
        },
    }


def test_returns_codes_from_recent_mail_by_the_items_domain(monkeypatch):
    now = datetime.now(UTC)
    messages = [
        {"uid": 3, "from": "Evil <x@evil.example>", "subject": "Code 111111"},
        {"uid": 2, "from": "CHECK24 <noreply@mail.check24.de>", "subject": "Code"},
        {"uid": 1, "from": "noreply@check24.de", "subject": "Code 999999"},
    ]
    for index, message in enumerate(messages):
        message["date"] = (now - timedelta(minutes=index * 20)).isoformat()
    messages[1]["date"] = (now - timedelta(minutes=2)).isoformat()

    class Mailbox:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def login(self, username, password):
            pass

    monkeypatch.setattr(logins, "read", lambda path: "secret")
    monkeypatch.setattr(mail, "connect", lambda server: Mailbox())
    monkeypatch.setattr(
        mail,
        "search_messages",
        lambda mailbox, params: {"total": 3, "messages": messages},
    )
    monkeypatch.setattr(
        mail,
        "read_message",
        lambda mailbox, params: {
            "text": f"Your code: 482913\n© {now.year} CHECK24, Tel. 089 1234"
        },
    )

    result = logins.login_codes(AUTH, "abc123")

    assert result["codes"] == ["482913", "1234"]
    with pytest.raises(logins.LoginError):
        logins.login_codes(AUTH, "../vault")
