"""
SVAKOM SL278K BLE 控制中继
轮询中继服务器取指令，通过蓝牙发送给设备，并每 1.5 秒续命保持运行。

SL278K 是两个独立的蓝牙设备（各自有 MAC）：
  主体 SL278K_V：震动 + 伸缩
  吸头 SL278K_S：吮吸
本脚本会连上所有名字含 SL278 的设备，每条指令广播给全部设备，各自只响应自己支持的。
协议来源：https://discuss.buttplug.io/t/867

用法：
  set BRIDGE_URL=https://your-railway-server.up.railway.app
  set BRIDGE_SECRET=your_secret
  python bridge.py
"""

import asyncio, os, time, requests
from bleak import BleakScanner, BleakClient

WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"
NAME_KEY = "SL278"
H = 0x55
KEEPALIVE_SEC = 1.5
POLL_SEC = 0.3

BRIDGE_URL = os.environ.get("BRIDGE_URL", "").rstrip("/")
BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "")

current_cmd = None
current_until = 0
clients = {}  # address -> BleakClient

# 震动 55 03 / 伸缩 55 08 / 吮吸 55 09：00 00 <模式> <强度 1-10> 00
FUNCS = {"vibrate": (3, 10), "stretch": (8, 7), "suck": (9, 5)}
INIT_SEQ = [
    bytes([H, 4, 0, 0, 1, 0xFF, 0xAA]),
    bytes([H, 4, 0, 0, 0, 0, 0xAA]),
    bytes([H, 4, 0, 0, 0, 0, 0xAA]),
    bytes([H, 3, 0, 0, 0, 0, 0]),
]


def log(s): print(s, flush=True)


def clampb(v, lo, hi): return max(lo, min(hi, int(round(v))))


def cmd_scale(v): return bytes([H, 4, 0, 0, 1, clampb(v, 0, 255), 0xAA])
def cmd_scale_stop(): return bytes([H, 4, 0, 0, 0, 0, 0xAA])


def cmd_func(f, mode, level):
    no, modes = FUNCS[f]
    return bytes([H, no, 0, 0, clampb(mode, 1, modes), clampb(level, 1, 10), 0])


def cmd_func_off(f): return bytes([H, FUNCS[f][0], 0, 0, 0, 0, 0])


def parse_duration(c):
    for k in ["sec", "seconds", "duration"]:
        if k in c:
            try:
                s = float(c[k])
            except (TypeError, ValueError):
                continue
            if s > 0:
                return time.monotonic() + s
    return 0


async def write(buf):
    for addr, cl in list(clients.items()):
        if cl.is_connected:
            try:
                await cl.write_gatt_char(WRITE_UUID, buf, response=False)
            except Exception as e:
                log(f"写入失败（{addr}）: {e}")


async def stop_all():
    global current_cmd, current_until
    current_cmd = None; current_until = 0
    await write(cmd_scale_stop())
    for f in FUNCS:
        await write(cmd_func_off(f))


async def switch_to(buf):
    """切换到别的功能时先全部关掉，避免叠在一起"""
    if current_cmd is not None and current_cmd[1] != buf[1]:
        await stop_all()


async def exec_cmd(c: dict):
    global current_cmd, current_until
    t = c.get("type")
    if c.get("stop") or t == "stop":
        await stop_all(); log("⏹ 停止"); return

    if t == "raw":
        # 调试用原始指令：只允许 0x55 开头、6-8 字节、指令号 3/4/8/9（都走 FFE1 控制通道）
        try:
            b = bytes(int(x, 16) for x in str(c.get("hex", "")).replace(",", " ").split())
        except ValueError:
            b = b""
        if not (6 <= len(b) <= 8 and b[0] == 0x55 and b[1] in (3, 4, 8, 9)):
            log(f"🚫 拒绝原始指令：{c.get('hex')}"); return
        current_cmd = b; current_until = parse_duration(c)
        await write(b); log(f"🧪 原始指令 {b.hex(' ')}"); return

    func = "vibrate" if (t == "pattern" or "pattern" in c) else t if t in ("suck", "stretch") else None
    if func:
        lv = float(c.get("level", 0.6))
        if lv <= 0:
            await stop_all(); log("⏹ 强度 0"); return
        mode = int(c.get("pattern" if func == "vibrate" else "mode", 1) or 1)
        buf = cmd_func(func, mode, lv * 10)
        await switch_to(buf)
        current_cmd = buf; current_until = parse_duration(c)
        await write(buf)
        name = {"vibrate": "🌀 震动花样", "stretch": "↕️ 伸缩模式", "suck": "💨 吮吸模式"}[func]
        log(f"{name} {buf[4]}，强度 {buf[5]}/10"); return

    val = c.get("speed", c.get("intensity"))
    if val is not None:
        v = float(val)
        if v <= 0:
            await stop_all(); log("⏹ 强度 0"); return
        buf = cmd_scale(min(1, v) * 255)
        await switch_to(buf)
        current_cmd = buf; current_until = parse_duration(c)
        await write(buf); log(f"📳 强度 {round(v * 100)}%"); return

    log(f"未识别的指令：{c}")


async def keepalive_loop():
    while True:
        await asyncio.sleep(KEEPALIVE_SEC)
        if current_until and time.monotonic() >= current_until:
            await stop_all(); log("⏱ 到时自动停"); continue
        if current_cmd is not None:
            await write(current_cmd)


async def bridge_loop():
    if not BRIDGE_URL:
        log("⚠️ 未设置 BRIDGE_URL"); return
    headers = {"x-bridge-secret": BRIDGE_SECRET} if BRIDGE_SECRET else {}
    while True:
        try:
            r = await asyncio.to_thread(requests.get, f"{BRIDGE_URL}/toy-next", headers=headers, timeout=4)
            if r.ok:
                c = r.json()
                if c and c.get("type") != "hello":
                    log(f"📨 {c}")
                    await exec_cmd(c)
        except Exception:
            pass
        await asyncio.sleep(POLL_SEC)


async def hold_device(dev):
    """连上一个设备、发初始化握手，断开后从列表移除，由扫描循环重新发现"""
    try:
        async with BleakClient(dev) as cl:
            clients[dev.address] = cl
            await asyncio.sleep(0.24)
            for buf in INIT_SEQ:
                await cl.write_gatt_char(WRITE_UUID, buf, response=False)
                await asyncio.sleep(0.03)
            try:
                await cl.start_notify(NOTIFY_UUID, lambda s, d: None)
            except Exception:
                pass
            log(f"🎉 {dev.name}（{dev.address}）就绪，当前已连 {len(clients)} 个设备")
            while cl.is_connected:
                await asyncio.sleep(1)
    except Exception as e:
        log(f"{dev.address} 断开: {e}")
    finally:
        clients.pop(dev.address, None)


async def ble_loop():
    holding = set()
    while True:
        devs = await BleakScanner.discover(timeout=5.0)
        for d in devs:
            if d.name and NAME_KEY in d.name and d.address not in holding:
                holding.add(d.address)
                log(f"🔗 连接 {d.name}（{d.address}）...")
                task = asyncio.create_task(hold_device(d))
                task.add_done_callback(lambda _t, a=d.address: holding.discard(a))
        if not holding:
            log("⚠️ 没找到设备，继续扫描…")
        # SL278K 有两个设备；都连上后放慢扫描
        await asyncio.sleep(15 if len(holding) >= 2 else 3)


async def main():
    await asyncio.gather(bridge_loop(), ble_loop(), keepalive_loop())


if __name__ == "__main__":
    asyncio.run(main())
