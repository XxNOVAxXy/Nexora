from __future__ import annotations

import base64
import json
import threading
import unittest
from typing import Any
from unittest.mock import patch

import httplib2
from fastapi.testclient import TestClient
from googleapiclient.errors import HttpError

from backend.app import main
from backend.app.gmail import GmailClient, GmailRateLimitError


def _raw_message(message_id: str) -> dict[str, Any]:
    return {
        "id": message_id,
        "threadId": f"t-{message_id}",
        "snippet": "Hola",
        "internalDate": "1700000000000",
        "labelIds": ["INBOX", "UNREAD"],
        "payload": {
            "headers": [{"name": "From", "value": "Banco <banco@example.com>"}, {"name": "Subject", "value": "Estado"}],
            "parts": [
                {"filename": "estado.pdf", "mimeType": "application/pdf", "body": {"attachmentId": "att-1", "size": 9}},
            ],
        },
    }


class _Request:
    def __init__(self, service: "FakeService", call: str, result: Any) -> None:
        self.service, self.call, self.result = service, call, result

    def execute(self, num_retries: int = 0) -> Any:
        self.service.calls.append(self.call)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class FakeService:
    def __init__(self, ids: list[str], unread: list[str]) -> None:
        self.ids, self.unread, self.calls = ids, unread, []
        self.error: Exception | None = None

    def users(self) -> "FakeService":
        return self

    def messages(self) -> "FakeService":
        return self

    def attachments(self) -> "FakeService":
        return self

    def list(self, userId: str, q: str, maxResults: int, pageToken: str | None = None) -> _Request:
        ids = self.unread if "is:unread" in q else self.ids
        return _Request(self, "list", self.error or {"messages": [{"id": item} for item in ids]})

    def get(self, userId: str, id: str, format: str | None = None, messageId: str | None = None) -> _Request:
        if messageId is not None:
            data = base64.urlsafe_b64encode(b"%PDF-1.7").decode()
            return _Request(self, "attachment", {"data": data})
        return _Request(self, "get", _raw_message(id))


class GmailCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = GmailClient()
        self.service = FakeService(ids=["m1", "m2"], unread=["m1"])
        patcher = patch.object(self.client, "service", return_value=self.service)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_second_listing_only_spends_list_calls_and_refreshes_unread(self) -> None:
        first = self.client.list_messages("inbox")["messages"]
        self.assertEqual(self.service.calls.count("get"), 2)
        self.assertEqual([m["unread"] for m in first], [True, False])

        self.service.calls.clear()
        self.service.unread = []  # m1 was read in Gmail meanwhile
        second = self.client.list_messages("inbox")["messages"]
        self.assertEqual(self.service.calls, ["list", "list"])
        self.assertEqual([m["unread"] for m in second], [False, False])
        self.assertNotIn("UNREAD", second[0]["labels"])

    def test_attachment_is_downloaded_once_and_keeps_listed_filename(self) -> None:
        self.client.list_messages("inbox")
        self.service.calls.clear()
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.client.attachment("m1", "att-1"))) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(self.service.calls, ["attachment"])
        self.assertEqual({r[2] for r in results}, {"estado.pdf"})

    def test_rate_limit_becomes_typed_error(self) -> None:
        content = json.dumps({"error": {"code": 403, "message": "Quota exceeded", "errors": [{"reason": "rateLimitExceeded"}]}}).encode()
        self.service.error = HttpError(httplib2.Response({"status": 403}), content)
        with self.assertRaises(GmailRateLimitError):
            self.client.list_messages("inbox")


class RateLimitRouteTests(unittest.TestCase):
    def test_listing_returns_429_with_retry_after(self) -> None:
        class ThrottledGmail:
            def profile(self) -> dict[str, Any]:
                return {"email": "a@example.com"}

            def list_messages(self, folder: str, max_results: int, page_token: str | None = None, query: str | None = None) -> dict[str, Any]:
                raise GmailRateLimitError("Gmail está limitando las consultas.")

        with patch.object(main, "gmail", ThrottledGmail()):
            response = TestClient(main.app).get("/api/gmail/messages?filtro=todos")
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers.get("retry-after"), "60")


if __name__ == "__main__":
    unittest.main()
