"""
SL278H BLE 控制中继
轮询中继服务器取指令，通过蓝牙发送给设备，并每 1.5 秒续命保持运行。
用法：
  set BRIDGE_URL=https://your-railway-server.up.railway.app
  set BRIDGE_SECRET=your_secret
  python bridge.py
"""

import asyncio, os, time, requests
from bleak import BleakScanner, BleakClient

WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"
H = 0x55
KEEPALIVE_SEC = 1.5
POLL_SEC = 0.3

BRIDGE_URL = os.environ.get("BRIDGE_URL", "").rstrip("/")
BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "")

current_cmd = None
current_until = 0
client_ref = None

def log(s): print(s, flush=True)

def cmd_scale(v):
    v = max(0, min(255, v))
    return bytes([H, 4, 0, 0, 1, v, 0xAA])

def cmd_scale_stop():
    return bytes([H, 4, 0, 0, 0, 0, 0xAA])

def cmd_vibrate(mode, level):
    return bytes([H, 3, 0, 0, max(1,min(8,mode)), max(1,min(5,level)), 0])

def parse_duration(c):
    for k in ["sec", "seconds", "duration"]:
        if k in c:
            s = float(c[k])
            if s > 0:
                return time.monotonic() + s
    return 0

async def write(buf):
    global client_ref
    if client_ref and client_ref.is_connected:
        try:
            await client_ref.write_gatt_char(WRITE_UUID, buf, response=False)
        except Exception as e:
            log(f"写入失败: {e}")

async def exec_cmd(c: dict):
    global current_cmd, current_until
    if c.get("stop") or c.get("type") == "stop":
        current_cmd = None; current_until = 0
        await write(cmd_scale_stop()); log("⏹ 停止"); return
    if "pattern" in c:
        mode = int(c["pattern"])
        level = max(1, round(c.get("level", 0.6) * 5))
        current_cmd = cmd_vibrate(mode, level)
        current_until = parse_duration(c)
        await write(current_cmd); log(f"🌀 花样 {mode} 档"); return
    val = c.get("speed") or c.get("suck") or c.get("intensity")
    if val is not None:
        if float(val) <= 0:
            current_cmd = None; current_until = 0
            await write(cmd_scale_stop()); log("⏹ 强度 0"); return
        current_cmd = cmd_scale(int(float(val) * 255))
        current_until = parse_duration(c)
        await write(current_cmd); log(f"📳 强度 {round(float(val)*100)}%")

async def keepalive_loop():
    global current_cmd, current_until
    while True:
        await asyncio.sleep(KEEPALIVE_SEC)
        if current_until and time.monotonic() >= current_until:
            current_cmd = None; current_until = 0
            await write(cmd_scale_stop()); log("⏱ 到时自动停"); continue
        if current_cmd is not None:
            await write(current_cmd)

async def bridge_loop():
    if not BRIDGE_URL:
        log("⚠️ 未设置 BRIDGE_URL"); return
    headers = {"x-bridge-secret": BRIDGE_SECRET} if BRIDGE_SECRET else {}
    while True:
        try:
            r = requests.get(f"{BRIDGE_URL}/toy-next", headers=headers, timeout=4)
            if r.ok:
                c = r.json()
                if c and c.get("type") != "hello" and len(c):
                    log(f"📨 {c}")
                    await exec_cmd(c)
        except Exception:
            pass
        await asyncio.sleep(POLL_SEC)

async def ble_loop():
    global client_ref
    while True:
        log("🔍 扫描 SL278H ...")
        devs = await BleakScanner.discover(timeout=6.0)
        dev = next((d for d in devs if d.name and "SL278" in d.name), None)
        if not dev:
            log("⚠️ 没找到设备，5秒后重试"); await asyncio.sleep(5); continue
        log(f"🔗 连接 {dev.name} ...")
        try:
            async with BleakClient(dev) as c:
                client_ref = c
                log("🎉 就绪！等待指令中...")
                try:
                    await c.start_notify(NOTIFY_UUID, lambda s, d: None)
                except Exception:
                    pass
                while c.is_connected:
                    await asyncio.sleep(1)
        except Exception as e:
            log(f"断开: {e}")
        client_ref = None
        await asyncio.sleep(2)

async def main():
    await asyncio.gather(bridge_loop(), ble_loop(), keepalive_loop())

if __name__ == "__main__":
    asyncio.run(main())
