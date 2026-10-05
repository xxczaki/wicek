import imaplib
import json
import re
import socketserver
import threading
from email.message import EmailMessage

import pytest
from mitmproxy import http

import mail

READ_ONLY_COMMANDS = {
    "CAPABILITY",
    "LOGIN",
    "EXAMINE",
    "LIST",
    "UID SEARCH",
    "UID FETCH",
    "LOGOUT",
}


def build_message(
    sender: str, subject: str, body: str, html: str | None = None
) -> bytes:
    message = EmailMessage()
    message["From"] = sender
    message["To"] = "antoni@icloud.com"
    message["Subject"] = subject
    message["Date"] = "Mon, 05 Oct 2026 09:30:00 +0200"
    if html is None:
        message.set_content(body)
    else:
        message.set_content(html, subtype="html")
    return message.as_bytes()


def with_attachment(raw: bytes) -> bytes:
    message = mail.parse_message(raw)
    message.make_mixed()
    message.add_attachment(
        b"%PDF-1.7", maintype="application", subtype="pdf", filename="invoice.pdf"
    )
    return message.as_bytes()


MESSAGES = {
    3: ("", build_message("Alice <alice@example.com>", "Lunch?", "Noon at Fabrik.")),
    7: (
        "\\Seen",
        with_attachment(
            build_message(
                "Bank <noreply@c24.de>",
                "=?utf-8?q?Kontoauszug_f=C3=BCr_September?=",
                "Attached.",
            )
        ),
    ),
    9: (
        "",
        build_message(
            "Shop <shop@example.com>",
            "Your order",
            "",
            html=(
                "<html><head><style>p{}</style></head>"
                "<body><p>Order&nbsp;#42 shipped</p><p>Track it</p></body></html>"
            ),
        ),
    ),
}


class FakeImapHandler(socketserver.StreamRequestHandler):
    def handle(self):
        self.send("* OK fake IMAP ready")
        while line := self.rfile.readline():
            tag, _, rest = line.decode().rstrip("\r\n").partition(" ")
            name, _, arguments = rest.partition(" ")
            if name == "UID":
                subcommand, _, arguments = arguments.partition(" ")
                name = f"UID {subcommand}"
            self.server.commands.append((name.upper(), arguments))
            if not self.reply(tag, name.upper(), arguments):
                return

    def reply(self, tag: str, name: str, arguments: str) -> bool:
        if name == "CAPABILITY":
            self.send("* CAPABILITY IMAP4rev1")
        elif name == "LOGIN":
            if arguments != 'antoni@icloud.com "app-password"':
                self.send(f"{tag} NO [AUTHENTICATIONFAILED] Authentication failed")
                return True
        elif name == "EXAMINE":
            if arguments != '"INBOX"':
                self.send(f"{tag} NO Mailbox does not exist")
                return True
            self.send(f"* {len(MESSAGES)} EXISTS")
            self.send(f"{tag} OK [READ-ONLY] EXAMINE completed")
            return True
        elif name == "LIST":
            self.send('* LIST (\\HasNoChildren) "/" "INBOX"')
            self.send('* LIST (\\HasNoChildren \\Sent) "/" "Sent Messages"')
            self.send('* LIST (\\Noselect \\HasChildren) "/" "Archive"')
        elif name == "UID SEARCH":
            matching = [
                str(uid) for uid in MESSAGES if '"alice"' not in arguments or uid == 3
            ]
            self.send("* SEARCH " + " ".join(matching))
        elif name == "UID FETCH":
            self.fetch(arguments)
        elif name == "LOGOUT":
            self.send("* BYE")
            self.send(f"{tag} OK LOGOUT completed")
            return False
        else:
            self.send(f"{tag} BAD Unsupported")
            return True
        self.send(f"{tag} OK done")
        return True

    def fetch(self, arguments: str):
        uid_set, _, items = arguments.partition(" ")
        headers_only = "HEADER.FIELDS" in items
        for sequence, uid in enumerate(uid_set.split(","), start=1):
            if int(uid) not in MESSAGES:
                continue
            flags, raw = MESSAGES[int(uid)]
            payload = raw.split(b"\n\n", 1)[0] + b"\n\n" if headers_only else raw
            section = "BODY[HEADER.FIELDS (FROM)]" if headers_only else "BODY[]"
            prefix = f"* {sequence} FETCH (UID {uid} FLAGS ({flags}) {section}"
            self.wfile.write(
                f"{prefix} {{{len(payload)}}}\r\n".encode() + payload + b")\r\n"
            )

    def send(self, line: str):
        self.wfile.write(f"{line}\r\n".encode())


@pytest.fixture
def imap_server(monkeypatch):
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), FakeImapHandler)
    server.daemon_threads = True
    server.commands = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(
        mail,
        "connect",
        lambda host: imaplib.IMAP4("127.0.0.1", server.server_address[1], timeout=5),
    )
    yield server
    server.shutdown()
    server.server_close()


def call(
    path: str, method: str = "GET", password: str = "app-password"
) -> tuple[int, dict]:
    request = http.Request.make(method, f"http://imap.broker{path}")
    response = mail.respond(request, "imap.mail.me.com", "antoni@icloud.com", password)
    return response.status_code, json.loads(response.content)


def assert_read_only(commands: list[tuple[str, str]]):
    assert {name for name, _ in commands} <= READ_ONLY_COMMANDS
    for name, arguments in commands:
        if name == "UID FETCH":
            assert "BODY.PEEK[" in arguments


def test_lists_selectable_folders_with_roles(imap_server):
    status, body = call("/folders")

    assert status == 200
    assert body == {
        "folders": [
            {"name": "INBOX", "role": None},
            {"name": "Sent Messages", "role": "sent"},
        ]
    }
    assert_read_only(imap_server.commands)


def test_searches_newest_first_with_decoded_headers(imap_server):
    status, body = call("/search?limit=2")

    assert status == 200
    assert body["total"] == 3
    assert [message["uid"] for message in body["messages"]] == [9, 7]
    assert body["messages"][1]["subject"] == "Kontoauszug für September"
    assert body["messages"][1]["seen"] is True
    assert body["messages"][1]["date"] == "2026-10-05T09:30:00+02:00"
    assert (
        "UID FETCH",
        "7,9 (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE)])",
    ) in imap_server.commands
    assert_read_only(imap_server.commands)


def test_translates_filters_into_imap_criteria(imap_server):
    status, body = call("/search?from=alice&since=2026-09-01&unseen=true")

    assert status == 200
    assert [message["uid"] for message in body["messages"]] == [3]
    assert (
        "UID SEARCH",
        'FROM "alice" SINCE 01-Sep-2026 UNSEEN',
    ) in imap_server.commands


def test_reads_a_message_without_marking_it_seen(imap_server):
    status, body = call("/message?uid=7")

    assert status == 200
    assert body["text"] == "Attached."
    assert body["truncated"] is False
    assert body["attachments"] == [
        {"filename": "invoice.pdf", "contentType": "application/pdf", "bytes": 8}
    ]
    assert ("EXAMINE", '"INBOX"') in imap_server.commands
    assert_read_only(imap_server.commands)


def test_converts_html_only_messages_to_text(imap_server):
    status, body = call("/message?uid=9")

    assert status == 200
    assert body["text"] == "Order\xa0#42 shipped\nTrack it"


@pytest.mark.parametrize(
    "path",
    [
        "/search?folder=INBOX%22%0D%0AA1%20STORE%201%20%2BFLAGS%20(%5CDeleted)",
        "/search?subject=x%0D%0AA1%20EXPUNGE",
        "/message?uid=1%20%2BFLAGS",
    ],
)
def test_rejects_command_injection_before_it_reaches_the_server(imap_server, path):
    status, body = call(path)

    assert status == 400
    assert "error" in body
    assert_read_only(imap_server.commands)
    assert not any(
        re.search(r"STORE|EXPUNGE|FLAGS", arguments) and name != "UID FETCH"
        for name, arguments in imap_server.commands
    )


def test_rejects_writes_and_unknown_endpoints(imap_server):
    assert call("/message?uid=7", method="DELETE")[0] == 405
    assert call("/expunge")[0] == 404
    assert imap_server.commands == []


def test_reports_missing_folders_and_messages(imap_server):
    assert call("/search?folder=Nope")[0] == 404
    assert call("/message?uid=99")[0] == 404


def test_reports_login_failures_as_bad_gateway(imap_server):
    status, body = call("/folders", password="wrong")

    assert status == 502
    assert "Authentication failed" in body["error"]
