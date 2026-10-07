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
clients = {}  # address -> (BleakClient, role)；role 是 "body" / "sucker" / "unknown"

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


# 加热：开 55 05 01 37 <通道> 00 00，关 55 05 00 00 <通道> 00 00
heat_idx = 2


def cmd_heat(on, idx):
    return bytes([H, 5, 1, 0x37, idx, 0, 0] if on else [H, 5, 0, 0, idx, 0, 0])


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


def route_of(buf):
    """吮吸 → 吸头；震动/伸缩 → 主体；整体强度、停止 → 全部"""
    if buf[1] == 9: return "sucker"
    if buf[1] in (3, 8): return "body"
    return "all"


def role_from_adv(adv):
    """从广播的厂商数据里认设备：产品编号 128 = 主体，129 = 吸头"""
    try:
        for data in (adv.manufacturer_data or {}).values():
            if 0x80 in data and 0x81 not in data: return "body"
            if 0x81 in data and 0x80 not in data: return "sucker"
    except Exception:
        pass
    return "unknown"


async def write(buf, target=None):
    to = target or route_of(buf)
    for addr, (cl, role) in list(clients.items()):
        # 认不出角色的设备什么都收，保证至少能用
        if to != "all" and role not in (to, "unknown"):
            continue
        if cl.is_connected:
            try:
                await cl.write_gatt_char(WRITE_UUID, buf, response=False)
            except Exception as e:
                log(f"写入失败（{addr}）: {e}")


async def stop_all():
    global current_cmd, current_until
    current_cmd = None; current_until = 0
    await write(cmd_scale_stop(), "all")
    for f in FUNCS:
        await write(cmd_func_off(f), "all")


async def switch_to(buf):
    """切换到别的功能时先全部关掉，避免叠在一起"""
    if current_cmd is not None and current_cmd[1] != buf[1]:
        await stop_all()


async def exec_cmd(c: dict):
    global current_cmd, current_until, heat_idx
    t = c.get("type")
    if c.get("stop") or t == "stop":
        await stop_all()
        # 两个设备的加热通道可能不同（吸头 1），都关一遍
        for i in {1, 2, heat_idx}:
            await write(cmd_heat(False, i), "all")
        log("⏹ 停止"); return

    if t == "heat":
        # 加热：只发一次，不进续命，也不影响正在跑的震动/吮吸
        heat_idx = clampb(float(c.get("idx", 2)), 0, 255)
        on = bool(c.get("on"))
        to = c.get("target") if c.get("target") in ("body", "sucker") else "all"
        where = {"body": "主体", "sucker": "吸头", "all": "主体 + 吸头"}[to]
        await write(cmd_heat(on, heat_idx), to)
        log(f"🔥 {where}加热开（通道 {heat_idx}）" if on else f"❄️ {where}加热关"); return

    if t == "raw":
        # 调试用原始指令：只允许 0x55 开头、6-8 字节、指令号 3/4/5/8/9（都走 FFE1 控制通道）
        try:
            b = bytes(int(x, 16) for x in str(c.get("hex", "")).replace(",", " ").split())
        except ValueError:
            b = b""
        if not (6 <= len(b) <= 8 and b[0] == 0x55 and b[1] in (3, 4, 5, 8, 9)):
            log(f"🚫 拒绝原始指令：{c.get('hex')}"); return
        current_cmd = b; current_until = parse_duration(c)
        await write(b, "all"); log(f"🧪 原始指令 {b.hex(' ')}"); return

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
        # 只给整体强度（55 04）续命。震动/伸缩/吮吸的模式指令重发会让节奏从头开始，
        # 导致有间隔的模式永远停在开头那段，所以只发一次
        if current_cmd is not None and current_cmd[1] == 4:
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


async def hold_device(dev, role):
    """连上一个设备、发初始化握手，断开后从列表移除，由扫描循环重新发现"""
    try:
        async with BleakClient(dev) as cl:
            clients[dev.address] = (cl, role)
            await asyncio.sleep(0.24)
            for buf in INIT_SEQ:
                await cl.write_gatt_char(WRITE_UUID, buf, response=False)
                await asyncio.sleep(0.03)
            try:
                await cl.start_notify(NOTIFY_UUID, lambda s, d: None)
            except Exception:
                pass
            name = {"body": "主体", "sucker": "吸头", "unknown": "未识别设备（所有指令都发）"}[role]
            log(f"🎉 {dev.name} {name}（{dev.address}）就绪，当前已连 {len(clients)} 个设备")
            while cl.is_connected:
                await asyncio.sleep(1)
    except Exception as e:
        log(f"{dev.address} 断开: {e}")
    finally:
        clients.pop(dev.address, None)


async def ble_loop():
    holding = set()
    while True:
        found = await BleakScanner.discover(timeout=5.0, return_adv=True)
        for d, adv in found.values():
            if d.name and NAME_KEY in d.name and d.address not in holding:
                holding.add(d.address)
                role = role_from_adv(adv)
                log(f"🔗 连接 {d.name}（{d.address}，{role}）...")
                task = asyncio.create_task(hold_device(d, role))
                task.add_done_callback(lambda _t, a=d.address: holding.discard(a))
        if not holding:
            log("⚠️ 没找到设备，继续扫描…")
        # SL278K 有两个设备；都连上后放慢扫描
        await asyncio.sleep(15 if len(holding) >= 2 else 3)


async def main():
    await asyncio.gather(bridge_loop(), ble_loop(), keepalive_loop())


if __name__ == "__main__":
    asyncio.run(main())
