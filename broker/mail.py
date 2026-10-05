import email
import email.policy
import html
import imaplib
import json
import re
import ssl
from datetime import date
from email.message import EmailMessage
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qs, urlsplit

from mitmproxy import http

IMAP_PORT = 993
IMAP_TIMEOUT_SECONDS = 20
DEFAULT_FOLDER = "INBOX"
DEFAULT_SEARCH_LIMIT = 20
MAX_SEARCH_LIMIT = 100
MAX_BODY_CHARACTERS = 20_000
SUMMARY_HEADERS = "FROM TO CC SUBJECT DATE"
TEXT_FILTERS = {"from": "FROM", "to": "TO", "subject": "SUBJECT", "text": "TEXT"}
DATE_FILTERS = {"since": "SINCE", "before": "BEFORE"}
MONTHS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)
FOLDER_ROLES = {
    b"\\sent": "sent",
    b"\\drafts": "drafts",
    b"\\junk": "junk",
    b"\\trash": "trash",
    b"\\archive": "archive",
}

LIST_LINE = re.compile(
    rb'^\((?P<flags>[^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (?P<name>.+)$'
)
FETCH_UID = re.compile(rb"\bUID (\d+)")
FETCH_FLAGS = re.compile(rb"\bFLAGS \(([^)]*)\)")
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
HIDDEN_HTML = re.compile(
    r"<(script|style|head)\b.*?</\1\s*>", re.IGNORECASE | re.DOTALL
)
LINE_BREAK_HTML = re.compile(
    r"<br\s*/?>|</(?:p|div|tr|li|h[1-6]|table)\s*>", re.IGNORECASE
)
HTML_TAG = re.compile(r"<[^>]+>")
REPEATED_BLANK_LINES = re.compile(r"\n[ \t\r\f\v]*(?:\n[ \t\r\f\v]*)+")


class MailError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def respond(
    request: http.Request, server: str, username: str, password: str
) -> http.Response:
    if request.method != "GET":
        return json_response(405, {"error": "The mail gateway is read-only"})

    url = urlsplit(request.url)
    handler = ROUTES.get(url.path)
    if not handler:
        return json_response(
            404, {"error": f"Unknown endpoint {url.path}", "endpoints": list(ROUTES)}
        )
    params = {name: values[-1] for name, values in parse_qs(url.query).items()}

    try:
        with connect(server) as mailbox:
            mailbox.login(username, password)
            return json_response(200, handler(mailbox, params))
    except MailError as error:
        return json_response(error.status, {"error": str(error)})
    except (imaplib.IMAP4.error, OSError) as error:
        return json_response(502, {"error": f"IMAP request failed: {error}"})


def connect(server: str) -> imaplib.IMAP4:
    return imaplib.IMAP4_SSL(
        server,
        IMAP_PORT,
        ssl_context=ssl.create_default_context(),
        timeout=IMAP_TIMEOUT_SECONDS,
    )


def list_folders(mailbox: imaplib.IMAP4, params: dict[str, str]) -> dict:
    _, lines = mailbox.list()
    folders = []
    for line in lines:
        match = LIST_LINE.match(line) if isinstance(line, bytes) else None
        if not match:
            continue
        flags = match["flags"].lower().split()
        if b"\\noselect" in flags:
            continue
        role = next(
            (FOLDER_ROLES[flag] for flag in flags if flag in FOLDER_ROLES), None
        )
        folders.append({"name": unquote(match["name"]), "role": role})
    return {"folders": folders}


def search_messages(mailbox: imaplib.IMAP4, params: dict[str, str]) -> dict:
    criteria = search_criteria(params)
    limit = parse_limit(params.get("limit"))
    if any(not argument.isascii() for argument in criteria):
        enable_utf8(mailbox)
    examine(mailbox, params.get("folder", DEFAULT_FOLDER))

    _, data = mailbox.uid("SEARCH", *criteria)
    uids = data[0].split() if data and data[0] else []
    newest = uids[-limit:]
    if not newest:
        return {"total": 0, "messages": []}

    _, fetched = mailbox.uid(
        "FETCH",
        b",".join(newest).decode(),
        f"(UID FLAGS BODY.PEEK[HEADER.FIELDS ({SUMMARY_HEADERS})])",
    )
    messages = [
        summarize(metadata, parse_message(payload))
        for metadata, payload in fetch_records(fetched)
    ]
    messages.sort(key=lambda message: message["uid"], reverse=True)
    return {"total": len(uids), "messages": messages}


def read_message(mailbox: imaplib.IMAP4, params: dict[str, str]) -> dict:
    uid = params.get("uid", "")
    if not uid.isdigit():
        raise MailError(400, "uid must be a number from /search")
    examine(mailbox, params.get("folder", DEFAULT_FOLDER))

    _, fetched = mailbox.uid("FETCH", uid, "(UID FLAGS BODY.PEEK[])")
    records = fetch_records(fetched)
    if not records:
        raise MailError(404, f"No message with uid {uid}")

    metadata, payload = records[0]
    message = parse_message(payload)
    text = body_text(message)
    return {
        **summarize(metadata, message),
        "text": text[:MAX_BODY_CHARACTERS],
        "truncated": len(text) > MAX_BODY_CHARACTERS,
        "attachments": [
            {
                "filename": part.get_filename(),
                "contentType": part.get_content_type(),
                "bytes": len(part.get_payload(decode=True) or b""),
            }
            for part in message.iter_attachments()
        ],
    }


ROUTES = {
    "/folders": list_folders,
    "/search": search_messages,
    "/message": read_message,
}


def search_criteria(params: dict[str, str]) -> list[str]:
    criteria = []
    for name, key in TEXT_FILTERS.items():
        if params.get(name):
            criteria += [key, quote(params[name])]
    for name, key in DATE_FILTERS.items():
        if params.get(name):
            criteria += [key, imap_date(params[name])]
    if params.get("unseen") in ("1", "true"):
        criteria.append("UNSEEN")
    return criteria or ["ALL"]


def parse_limit(value: str | None) -> int:
    if value is None:
        return DEFAULT_SEARCH_LIMIT
    if not value.isdigit() or not 1 <= int(value) <= MAX_SEARCH_LIMIT:
        raise MailError(400, f"limit must be between 1 and {MAX_SEARCH_LIMIT}")
    return int(value)


def imap_date(value: str) -> str:
    try:
        day = date.fromisoformat(value)
    except ValueError as error:
        raise MailError(400, f"Dates must be YYYY-MM-DD, got {value!r}") from error
    return f"{day.day:02d}-{MONTHS[day.month - 1]}-{day.year}"


def quote(value: str) -> str:
    if CONTROL_CHARACTERS.search(value):
        raise MailError(400, "Control characters are not allowed")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def unquote(value: bytes) -> str:
    text = value.decode("utf-8", "replace")
    if len(text) >= 2 and text.startswith('"') and text.endswith('"'):
        return re.sub(r"\\(.)", r"\1", text[1:-1])
    return text


def enable_utf8(mailbox: imaplib.IMAP4):
    try:
        mailbox.enable("UTF8=ACCEPT")
    except imaplib.IMAP4.error as error:
        raise MailError(400, "The server does not support non-ASCII search") from error


def examine(mailbox: imaplib.IMAP4, folder: str):
    status, _ = mailbox.select(quote(folder), readonly=True)
    if status != "OK":
        raise MailError(404, f"Cannot open folder {folder!r}")


def fetch_records(data: list) -> list[tuple[bytes, bytes]]:
    records = []
    for index, item in enumerate(data):
        if not isinstance(item, tuple):
            continue
        following = data[index + 1] if index + 1 < len(data) else b""
        trailing = following if isinstance(following, bytes) else b""
        records.append((item[0] + trailing, item[1]))
    return records


def parse_message(payload: bytes) -> EmailMessage:
    return email.message_from_bytes(payload, policy=email.policy.default)


def summarize(metadata: bytes, message: EmailMessage) -> dict:
    uid = FETCH_UID.search(metadata)
    flags = FETCH_FLAGS.search(metadata)
    return {
        "uid": int(uid[1]) if uid else None,
        "date": iso_date(message.get("date")),
        "from": str(message.get("from", "")),
        "to": str(message.get("to", "")),
        "cc": str(message.get("cc", "")),
        "subject": str(message.get("subject", "")),
        "seen": bool(flags and b"\\seen" in flags[1].lower().split()),
    }


def iso_date(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return parsedate_to_datetime(str(value)).isoformat()
    except (TypeError, ValueError):
        return str(value)


def body_text(message: EmailMessage) -> str:
    part = message.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    try:
        content = part.get_content()
    except (LookupError, UnicodeError):
        content = (part.get_payload(decode=True) or b"").decode("utf-8", "replace")
    if part.get_content_subtype() == "html":
        return html_to_text(content)
    return content.strip()


def html_to_text(markup: str) -> str:
    text = HIDDEN_HTML.sub("", markup)
    text = LINE_BREAK_HTML.sub("\n", text)
    text = html.unescape(HTML_TAG.sub("", text))
    return REPEATED_BLANK_LINES.sub("\n\n", text).strip()


def json_response(status: int, body: dict) -> http.Response:
    return http.Response.make(
        status,
        json.dumps(body, ensure_ascii=False).encode(),
        {"content-type": "application/json; charset=utf-8"},
    )
