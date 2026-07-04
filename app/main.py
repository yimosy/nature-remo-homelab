"""Nature Remo Local API を操作するホームラボ用 Web サービス。

- 端末制限: ブラウザごとに Cookie トークンを発行し、管理者が承認した端末のみ操作可能
- 管理者: ADMIN_TOKEN 環境変数のトークンでログイン
- オプション: ALLOW_CIDRS でネットワークレベルの IP 制限
"""

from __future__ import annotations

import ipaddress
import json
import os
import secrets
import sqlite3
from contextlib import closing
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DB_PATH = os.environ.get("DB_PATH", "./data/remo.db")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
ALLOW_CIDRS = [c.strip() for c in os.environ.get("ALLOW_CIDRS", "").split(",") if c.strip()]
TRUST_PROXY = os.environ.get("TRUST_PROXY", "").lower() in ("1", "true", "yes")
STATIC_DIR = Path(__file__).parent / "static"

if not ADMIN_TOKEN:
    ADMIN_TOKEN = secrets.token_urlsafe(24)
    print("=" * 60)
    print("警告: ADMIN_TOKEN が未設定のため自動生成しました。")
    print(f"  ADMIN_TOKEN: {ADMIN_TOKEN}")
    print("  再起動すると変わります。docker-compose.yml で固定してください。")
    print("=" * 60)

app = FastAPI(title="Nature Remo Homelab")


# ---------------------------------------------------------------- DB

def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with closing(db()) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS devices(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              token TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              created_at TEXT DEFAULT (datetime('now', 'localtime')),
              last_seen TEXT
            );
            CREATE TABLE IF NOT EXISTS remos(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              ip TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS appliances(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              remo_id INTEGER NOT NULL REFERENCES remos(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              icon TEXT NOT NULL DEFAULT '🔘'
            );
            CREATE TABLE IF NOT EXISTS signals(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              appliance_id INTEGER NOT NULL REFERENCES appliances(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              payload TEXT NOT NULL
            );
            """
        )
        conn.commit()


init_db()


# ---------------------------------------------------------------- 認証

def client_ip(request: Request) -> str:
    if TRUST_PROXY:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


@app.middleware("http")
async def ip_filter(request: Request, call_next):
    if ALLOW_CIDRS:
        ip = client_ip(request)
        try:
            addr = ipaddress.ip_address(ip)
            allowed = any(addr in ipaddress.ip_network(c) for c in ALLOW_CIDRS)
        except ValueError:
            allowed = False
        if not allowed:
            return JSONResponse({"detail": "このネットワークからのアクセスは許可されていません"}, status_code=403)
    return await call_next(request)


def get_device(request: Request):
    token = request.cookies.get("device_token")
    if not token:
        return None
    with closing(db()) as conn:
        row = conn.execute("SELECT * FROM devices WHERE token=?", (token,)).fetchone()
        if row:
            conn.execute("UPDATE devices SET last_seen=datetime('now','localtime') WHERE id=?", (row["id"],))
            conn.commit()
        return row


def is_admin(request: Request) -> bool:
    token = request.cookies.get("admin_token") or request.headers.get("x-admin-token")
    return token is not None and secrets.compare_digest(token, ADMIN_TOKEN)


def require_control(request: Request) -> None:
    """承認済み端末または管理者のみ操作可能。"""
    if is_admin(request):
        return
    device = get_device(request)
    if not device or device["status"] != "approved":
        raise HTTPException(403, "この端末は承認されていません")


def require_admin(request: Request) -> None:
    if not is_admin(request):
        raise HTTPException(403, "管理者権限が必要です")


# ---------------------------------------------------------------- Nature Remo Local API

REMO_HEADERS = {"X-Requested-With": "nature-remo-homelab", "Accept": "application/json"}


async def remo_get_messages(ip: str) -> dict | None:
    async with httpx.AsyncClient(timeout=5) as client:
        res = await client.get(f"http://{ip}/messages", headers=REMO_HEADERS)
        res.raise_for_status()
        if not res.text.strip():
            return None
        return res.json()


async def remo_post_messages(ip: str, payload: dict) -> None:
    async with httpx.AsyncClient(timeout=5) as client:
        res = await client.post(
            f"http://{ip}/messages",
            content=json.dumps(payload),
            headers={**REMO_HEADERS, "Content-Type": "application/json"},
        )
        res.raise_for_status()


def validate_payload(payload) -> dict:
    if not isinstance(payload, dict):
        raise HTTPException(400, "信号データが不正です")
    data = payload.get("data")
    freq = payload.get("freq")
    fmt = payload.get("format")
    if (
        not isinstance(data, list)
        or not data
        or not all(isinstance(x, int) and x >= 0 for x in data)
        or not isinstance(freq, (int, float))
        or not isinstance(fmt, str)
    ):
        raise HTTPException(400, "信号データが不正です")
    return {"format": fmt, "freq": freq, "data": data}


# ---------------------------------------------------------------- モデル

class RegisterIn(BaseModel):
    name: str


class AdminLoginIn(BaseModel):
    token: str


class RemoIn(BaseModel):
    name: str
    ip: str


class ApplianceIn(BaseModel):
    remo_id: int
    name: str
    icon: str = "🔘"


class SignalIn(BaseModel):
    name: str
    payload: dict


# ---------------------------------------------------------------- 端末登録・認証 API

@app.get("/api/me")
def me(request: Request):
    device = get_device(request)
    return {
        "admin": is_admin(request),
        "device": {"id": device["id"], "name": device["name"], "status": device["status"]} if device else None,
    }


@app.post("/api/register")
def register(body: RegisterIn, request: Request, response: Response):
    name = body.name.strip()[:40]
    if not name:
        raise HTTPException(400, "端末名を入力してください")
    if get_device(request):
        raise HTTPException(400, "この端末は登録済みです")
    token = secrets.token_urlsafe(32)
    with closing(db()) as conn:
        conn.execute("INSERT INTO devices(token, name) VALUES(?, ?)", (token, name))
        conn.commit()
    response.set_cookie(
        "device_token", token,
        max_age=60 * 60 * 24 * 365 * 5, httponly=True, samesite="lax",
    )
    return {"status": "pending"}


@app.post("/api/admin/login")
def admin_login(body: AdminLoginIn, response: Response):
    if not secrets.compare_digest(body.token, ADMIN_TOKEN):
        raise HTTPException(403, "トークンが違います")
    response.set_cookie(
        "admin_token", ADMIN_TOKEN,
        max_age=60 * 60 * 24 * 30, httponly=True, samesite="lax",
    )
    return {"ok": True}


@app.post("/api/admin/logout")
def admin_logout(response: Response):
    response.delete_cookie("admin_token")
    return {"ok": True}


# ---------------------------------------------------------------- 端末管理 API(管理者)

@app.get("/api/admin/devices")
def list_devices(request: Request):
    require_admin(request)
    with closing(db()) as conn:
        rows = conn.execute("SELECT id, name, status, created_at, last_seen FROM devices ORDER BY id").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/admin/devices/{device_id}/status")
def set_device_status(device_id: int, body: dict, request: Request):
    require_admin(request)
    status = body.get("status")
    if status not in ("approved", "blocked", "pending"):
        raise HTTPException(400, "status は approved / blocked / pending のいずれかです")
    with closing(db()) as conn:
        cur = conn.execute("UPDATE devices SET status=? WHERE id=?", (status, device_id))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "端末が見つかりません")
    return {"ok": True}


@app.delete("/api/admin/devices/{device_id}")
def delete_device(device_id: int, request: Request):
    require_admin(request)
    with closing(db()) as conn:
        conn.execute("DELETE FROM devices WHERE id=?", (device_id,))
        conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------- Remo 管理 API

@app.get("/api/remos")
def list_remos(request: Request):
    require_control(request)
    with closing(db()) as conn:
        rows = conn.execute("SELECT id, name, ip FROM remos ORDER BY id").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/remos")
async def add_remo(body: RemoIn, request: Request):
    require_admin(request)
    name, ip = body.name.strip(), body.ip.strip()
    if not name or not ip:
        raise HTTPException(400, "名前と IP アドレスを入力してください")
    with closing(db()) as conn:
        cur = conn.execute("INSERT INTO remos(name, ip) VALUES(?, ?)", (name, ip))
        conn.commit()
        remo_id = cur.lastrowid
    return {"id": remo_id}


@app.delete("/api/remos/{remo_id}")
def delete_remo(remo_id: int, request: Request):
    require_admin(request)
    with closing(db()) as conn:
        conn.execute("DELETE FROM remos WHERE id=?", (remo_id,))
        conn.commit()
    return {"ok": True}


@app.post("/api/remos/{remo_id}/test")
async def test_remo(remo_id: int, request: Request):
    require_admin(request)
    ip = _remo_ip(remo_id)
    try:
        await remo_get_messages(ip)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Remo({ip})に接続できません: {e}")
    return {"ok": True}


@app.post("/api/remos/{remo_id}/learn")
async def learn_signal(remo_id: int, request: Request):
    """Remo が最後に受信した赤外線信号を取得する。"""
    require_admin(request)
    ip = _remo_ip(remo_id)
    try:
        payload = await remo_get_messages(ip)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Remo({ip})から受信できません: {e}")
    if payload is None:
        return {"payload": None}
    return {"payload": payload}


def _remo_ip(remo_id: int) -> str:
    with closing(db()) as conn:
        row = conn.execute("SELECT ip FROM remos WHERE id=?", (remo_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Remo が見つかりません")
    return row["ip"]


# ---------------------------------------------------------------- 家電・信号 API

@app.get("/api/appliances")
def list_appliances(request: Request):
    require_control(request)
    with closing(db()) as conn:
        apps = conn.execute(
            """
            SELECT a.id, a.name, a.icon, a.remo_id, r.name AS remo_name
            FROM appliances a JOIN remos r ON r.id = a.remo_id
            ORDER BY a.id
            """
        ).fetchall()
        sigs = conn.execute("SELECT id, appliance_id, name FROM signals ORDER BY id").fetchall()
    by_app: dict[int, list] = {}
    for s in sigs:
        by_app.setdefault(s["appliance_id"], []).append({"id": s["id"], "name": s["name"]})
    return [{**dict(a), "signals": by_app.get(a["id"], [])} for a in apps]


@app.post("/api/appliances")
def add_appliance(body: ApplianceIn, request: Request):
    require_admin(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "家電名を入力してください")
    with closing(db()) as conn:
        if not conn.execute("SELECT 1 FROM remos WHERE id=?", (body.remo_id,)).fetchone():
            raise HTTPException(404, "Remo が見つかりません")
        cur = conn.execute(
            "INSERT INTO appliances(remo_id, name, icon) VALUES(?, ?, ?)",
            (body.remo_id, name, body.icon.strip() or "🔘"),
        )
        conn.commit()
        return {"id": cur.lastrowid}


@app.delete("/api/appliances/{appliance_id}")
def delete_appliance(appliance_id: int, request: Request):
    require_admin(request)
    with closing(db()) as conn:
        conn.execute("DELETE FROM appliances WHERE id=?", (appliance_id,))
        conn.commit()
    return {"ok": True}


@app.post("/api/appliances/{appliance_id}/signals")
def add_signal(appliance_id: int, body: SignalIn, request: Request):
    require_admin(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "信号名を入力してください")
    payload = validate_payload(body.payload)
    with closing(db()) as conn:
        if not conn.execute("SELECT 1 FROM appliances WHERE id=?", (appliance_id,)).fetchone():
            raise HTTPException(404, "家電が見つかりません")
        cur = conn.execute(
            "INSERT INTO signals(appliance_id, name, payload) VALUES(?, ?, ?)",
            (appliance_id, name, json.dumps(payload)),
        )
        conn.commit()
        return {"id": cur.lastrowid}


@app.delete("/api/signals/{signal_id}")
def delete_signal(signal_id: int, request: Request):
    require_admin(request)
    with closing(db()) as conn:
        conn.execute("DELETE FROM signals WHERE id=?", (signal_id,))
        conn.commit()
    return {"ok": True}


@app.post("/api/signals/{signal_id}/send")
async def send_signal(signal_id: int, request: Request):
    require_control(request)
    with closing(db()) as conn:
        row = conn.execute(
            """
            SELECT s.payload, r.ip FROM signals s
            JOIN appliances a ON a.id = s.appliance_id
            JOIN remos r ON r.id = a.remo_id
            WHERE s.id = ?
            """,
            (signal_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "信号が見つかりません")
    try:
        await remo_post_messages(row["ip"], json.loads(row["payload"]))
    except httpx.HTTPError as e:
        raise HTTPException(502, f"送信に失敗しました: {e}")
    return {"ok": True}


# ---------------------------------------------------------------- 静的ファイル

@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
