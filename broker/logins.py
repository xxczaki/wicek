import json
import logging
import os
import re
import subprocess
import tempfile
from datetime import UTC, datetime, timedelta
from email.utils import parseaddr
from urllib.parse import parse_qs, quote_plus, urlsplit

from mitmproxy import http

import mail

PLACEHOLDER_PREFIX = "WICEK_LOGIN_"
PLACEHOLDER = re.compile(rb"WICEK_LOGIN_([a-z0-9]+)_(USERNAME|PASSWORD)")
ITEM_ID = re.compile(r"[a-z0-9]+")
CODE = re.compile(r"(?<!\d)\d{4,8}(?!\d)")
OP_TIMEOUT_SECONDS = 20
CODE_MAX_AGE = timedelta(minutes=10)
CODE_SEARCH_LIMIT = 10
MAX_CODES = 5

logger = logging.getLogger(__name__)


class LoginError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def respond(request: http.Request, auth: dict) -> http.Response:
    if request.method != "GET":
        return mail.json_response(405, {"error": "The login gateway is read-only"})

    url = urlsplit(request.url)
    params = {name: values[-1] for name, values in parse_qs(url.query).items()}
    try:
        if url.path == "/list":
            return mail.json_response(200, {"logins": list_logins(auth)})
        if url.path == "/code":
            return mail.json_response(200, login_codes(auth, params.get("item", "")))
        return mail.json_response(404, {"error": f"Unknown endpoint {url.path}"})
    except (LoginError, mail.MailError) as error:
        return mail.json_response(error.status, {"error": str(error)})
    except (subprocess.SubprocessError, OSError) as error:
        return mail.json_response(502, {"error": f"Lookup failed: {error}"})


def fill_placeholders(request: http.Request, auth: dict):
    body = request.raw_content
    if (
        not body
        or PLACEHOLDER_PREFIX.encode() not in body
        or request.headers.get("content-encoding")
    ):
        return

    content_type = request.headers.get("content-type", "")
    for item_id in {match[1].decode() for match in PLACEHOLDER.finditer(body)}:
        item = run_op(auth, "item", "get", item_id)
        if not is_allowed(item_domains(item), request.pretty_host):
            logger.warning(f"login {item_id} not filled for {request.pretty_host}")
            continue
        for purpose in ("USERNAME", "PASSWORD"):
            value = field_value(item, purpose)
            if value is not None:
                body = body.replace(
                    placeholder(item_id, purpose).encode(),
                    encode_for(content_type, value).encode(),
                )
        logger.info(f"login {item_id} filled for {request.pretty_host}")
    request.content = body


def list_logins(auth: dict) -> list[dict]:
    return [
        {
            "item": item["id"],
            "title": item["title"],
            "domains": sorted(item_domains(item)),
            "placeholders": {
                "username": placeholder(item["id"], "USERNAME"),
                "password": placeholder(item["id"], "PASSWORD"),
            },
        }
        for item in run_op(auth, "item", "list", "--categories", "Login")
    ]


def login_codes(auth: dict, item_id: str) -> dict:
    if not ITEM_ID.fullmatch(item_id):
        raise LoginError(400, "item must be an id from /list")
    domains = item_domains(run_op(auth, "item", "get", item_id))
    now = datetime.now(UTC)

    with mail.connect(auth["mailServer"]) as mailbox:
        mailbox.login(read(auth["mailUsernameFile"]), read(auth["mailPasswordFile"]))
        found = mail.search_messages(
            mailbox,
            {
                "since": (now - CODE_MAX_AGE).date().isoformat(),
                "limit": str(CODE_SEARCH_LIMIT),
            },
        )
        for message in found["messages"]:
            sender = parseaddr(message["from"])[1].rpartition("@")[2].lower()
            if (
                not is_allowed(domains, sender)
                or received(message) < now - CODE_MAX_AGE
            ):
                continue
            text = mail.read_message(mailbox, {"uid": str(message["uid"])})["text"]
            codes = CODE.findall(f"{message['subject']}\n{text}")
            return {
                "codes": [
                    code for code in dict.fromkeys(codes) if code != str(now.year)
                ][:MAX_CODES],
                "received": message["date"],
            }
    return {"codes": []}


def run_op(auth: dict, *args: str):
    result = subprocess.run(
        ["op", *args, "--vault", auth["vault"], "--format", "json"],
        env={
            "PATH": os.environ["PATH"],
            "HOME": tempfile.gettempdir(),
            "OP_SERVICE_ACCOUNT_TOKEN": read(auth["tokenFile"]),
        },
        capture_output=True,
        text=True,
        timeout=OP_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        raise LoginError(502, f"1Password: {result.stderr.strip()}")
    return json.loads(result.stdout)


def item_domains(item: dict) -> set[str]:
    domains = set()
    for url in item.get("urls", []):
        href = url.get("href", "")
        hostname = urlsplit(href if "://" in href else f"https://{href}").hostname
        if hostname:
            domains.add(hostname.removeprefix("www."))
    return domains


def is_allowed(domains: set[str], host: str) -> bool:
    host = host.lower()
    return any(host == domain or host.endswith(f".{domain}") for domain in domains)


def field_value(item: dict, purpose: str) -> str | None:
    return next(
        (
            field.get("value")
            for field in item.get("fields", [])
            if field.get("purpose") == purpose
        ),
        None,
    )


def placeholder(item_id: str, purpose: str) -> str:
    return f"{PLACEHOLDER_PREFIX}{item_id}_{purpose}"


def encode_for(content_type: str, value: str) -> str:
    if content_type.startswith("application/x-www-form-urlencoded"):
        return quote_plus(value)
    if "json" in content_type:
        return json.dumps(value)[1:-1]
    return value


def received(message: dict) -> datetime:
    try:
        moment = datetime.fromisoformat(message["date"] or "")
    except ValueError:
        return datetime.min.replace(tzinfo=UTC)
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def read(path: str) -> str:
    with open(path) as secret_file:
        return secret_file.read().strip()
