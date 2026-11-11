"""后台调用示例；仅用于服务端，不要把管理员密钥放进前端。"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


class MailboxClient:
    def __init__(self, base_url: str, admin_key: str):
        if not base_url.startswith("https://"):
            raise ValueError("生产地址必须使用 HTTPS")
        if not admin_key:
            raise ValueError("缺少管理员密钥")
        self.base_url = base_url.rstrip("/")
        self.admin_key = admin_key

    def _call(self, method: str, path: str, payload: dict | None = None) -> dict:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Authorization": f"Bearer {self.admin_key}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.base_url + path, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=15) as response:
                return json.load(response)
        except HTTPError as exc:
            try:
                detail = json.load(exc)
            except (ValueError, OSError):
                detail = {"error": "服务请求失败"}
            raise RuntimeError(f"邮箱服务返回 {exc.code}: {detail.get('error')}") from exc

    def create(self, order_id: str, expires_at: datetime) -> dict:
        if expires_at.tzinfo is None or expires_at.utcoffset() is None:
            raise ValueError("expires_at 必须带时区")
        return self._call("POST", "/api/admin/mailboxes", {
            "externalId": order_id,
            "expiresAt": expires_at.isoformat(),
        })

    def get(self, mailbox_id: str) -> dict:
        return self._call("GET", f"/api/admin/mailboxes/{quote(mailbox_id)}")

    def verification_code(self, mailbox_id: str, since: datetime) -> dict:
        if since.tzinfo is None or since.utcoffset() is None:
            raise ValueError("since 必须带时区")
        return self._call("GET", f"/api/admin/mailboxes/{quote(mailbox_id)}/code?since={quote(since.isoformat())}")

    def issue_credentials(self, mailbox_id: str) -> dict:
        """只在预约成功、准备交付时调用；返回的密码只出现这一次。"""
        return self._call("POST", f"/api/admin/mailboxes/{quote(mailbox_id)}/credentials")

    def disable(self, mailbox_id: str) -> dict:
        return self._call("POST", f"/api/admin/mailboxes/{quote(mailbox_id)}/disable")


def main() -> None:
    parser = argparse.ArgumentParser(description="Pokemon 专属邮箱服务管理示例")
    subcommands = parser.add_subparsers(dest="command", required=True)
    create = subcommands.add_parser("create")
    create.add_argument("order_id")
    create.add_argument("expires_at", help="带时区的 ISO 8601 时间，如 2026-12-01T12:00:00+09:00")
    get = subcommands.add_parser("get")
    get.add_argument("mailbox_id")
    code = subcommands.add_parser("code")
    code.add_argument("mailbox_id")
    code.add_argument("since", help="开始等待验证码的带时区时间，最近 24 小时内")
    credentials = subcommands.add_parser("credentials")
    credentials.add_argument("mailbox_id")
    disable = subcommands.add_parser("disable")
    disable.add_argument("mailbox_id")
    args = parser.parse_args()

    client = MailboxClient(
        os.environ.get("MAILBOX_SERVICE_URL", ""),
        os.environ.get("MAILBOX_ADMIN_API_KEY", ""),
    )
    if args.command == "create":
        result = client.create(args.order_id, datetime.fromisoformat(args.expires_at))
    elif args.command == "get":
        result = client.get(args.mailbox_id)
    elif args.command == "code":
        result = client.verification_code(args.mailbox_id, datetime.fromisoformat(args.since))
    elif args.command == "credentials":
        result = client.issue_credentials(args.mailbox_id)
    else:
        result = client.disable(args.mailbox_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
