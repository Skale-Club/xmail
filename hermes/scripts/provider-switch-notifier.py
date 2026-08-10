#!/usr/bin/env python3
"""Send a Telegram alert whenever Hermes activates a fallback model."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path


FALLBACK_MARKER = "Fallback activated: "
TRANSITION_PATTERN = re.compile(
    r"^(?P<old>.+?) → (?P<new>.+?) \((?P<provider>[^)]+)\)\s*$"
)
SESSION_PATTERN = re.compile(r"\[([^\]]+)\]")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--test", action="store_true")
    return parser.parse_args()


def telegram_credentials() -> tuple[str, str]:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_HOME_CHANNEL", "").strip()
    if not token or not chat_id:
        raise RuntimeError("TELEGRAM_BOT_TOKEN/TELEGRAM_HOME_CHANNEL ausentes")
    return token, chat_id


def send_telegram(message: str) -> None:
    token, chat_id = telegram_credentials()
    body = urllib.parse.urlencode(
        {"chat_id": chat_id, "text": message, "disable_web_page_preview": "true"}
    ).encode()
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=body,
        method="POST",
    )

    last_error: Exception | None = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read())
                if not payload.get("ok"):
                    raise RuntimeError(f"Telegram recusou a mensagem: {payload}")
                return
        except Exception as error:  # retried and surfaced to systemd
            last_error = error
            time.sleep(min(2**attempt, 16))
    raise RuntimeError(f"Falha ao notificar Telegram: {last_error}")


def load_position(state_path: Path, log_path: Path) -> tuple[int, int] | None:
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        if state.get("path") == str(log_path):
            return int(state["inode"]), int(state["offset"])
    except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        pass
    return None


def save_position(state_path: Path, log_path: Path, inode: int, offset: int) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = state_path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps({"path": str(log_path), "inode": inode, "offset": offset}),
        encoding="utf-8",
    )
    temporary.replace(state_path)


def parse_fallback(line: str) -> dict[str, str] | None:
    if FALLBACK_MARKER not in line:
        return None
    prefix, transition = line.rsplit(FALLBACK_MARKER, 1)
    match = TRANSITION_PATTERN.match(transition)
    if not match:
        return None
    session_match = SESSION_PATTERN.search(prefix)
    return {
        **match.groupdict(),
        "timestamp": prefix[:23].strip(),
        "session": session_match.group(1) if session_match else "não identificada",
    }


def format_alert(event: dict[str, str]) -> str:
    provider = event["provider"]
    openrouter_note = "\n💳 OpenRouter está em uso." if provider.lower() == "openrouter" else ""
    return (
        "⚠️ Hermes mudou de modelo automaticamente\n\n"
        f"De: {event['old']}\n"
        f"Para: {event['new']}\n"
        f"Provedor: {provider}\n"
        f"Sessão: {event['session']}\n"
        f"Horário: {event['timestamp']} ET\n\n"
        "Motivo: o modelo anterior falhou, atingiu limite ou ficou indisponível."
        f"{openrouter_note}"
    )


def follow(log_path: Path, state_path: Path) -> None:
    while not log_path.exists():
        time.sleep(2)

    stat = log_path.stat()
    saved = load_position(state_path, log_path)
    position = stat.st_size
    if saved and saved[0] == stat.st_ino and saved[1] <= stat.st_size:
        position = saved[1]
    save_position(state_path, log_path, stat.st_ino, position)

    while True:
        with log_path.open("r", encoding="utf-8", errors="replace") as log_file:
            log_file.seek(position)
            while True:
                line = log_file.readline()
                if line:
                    event = parse_fallback(line.rstrip("\n"))
                    if event:
                        send_telegram(format_alert(event))
                    position = log_file.tell()
                    save_position(state_path, log_path, stat.st_ino, position)
                    continue

                time.sleep(1)
                current = log_path.stat()
                if current.st_ino != stat.st_ino or current.st_size < position:
                    stat = current
                    position = 0
                    break


def main() -> int:
    args = parse_args()
    if args.test:
        send_telegram(
            "✅ Monitor de troca de modelo do Hermes ativado. "
            "Você será avisado sempre que um fallback for acionado."
        )
        return 0
    follow(args.log, args.state)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except Exception as exc:
        print(f"provider-switch-notifier: {exc}", file=sys.stderr, flush=True)
        raise
