# SVAKOM SL278K · 用 Claude 远程控制

让 Claude.ai 通过 MCP 连接器控制 SVAKOM 分欣 Plus（FATIMA PLUS，蓝牙名 SL278K）：吮吸、震动、伸缩、加热、节奏序列。

```
Claude.ai（mcp 连接器）
    ↓ HTTPS · JSON-RPC
Railway 上的 index.js（指令队列 + 节奏序列）
    ↓ HTTP 轮询，每 300ms
蓝牙中继：手机网页 /relay  或  电脑 bridge.py
    ↓ BLE write-without-response（FFE1）
主体 SL278K_V（震动 + 伸缩 + 加热）  +  吸头 SL278K_S（吮吸 + 加热）
```

---

## 一、部署

### 1. Railway 服务器

1. Fork 本仓库，Railway → New Project → Deploy from GitHub Repo
2. Variables 里加 `BRIDGE_SECRET`，**只用字母和数字**（会写进网址）
3. Settings → Networking → 生成公开域名，例如 `https://xxx.up.railway.app`

### 2. 蓝牙中继（二选一，不要同时开）

**手机网页（推荐，安卓 Chrome / Edge）**

1. 手机打开 `https://xxx.up.railway.app/relay`，填 Secret
2. SL278K 是两个蓝牙设备，弹窗里都叫 SL278K 分不出来，所以**连哪个就先只开哪个**：
   - 只开吸头 → 点「连接吸头」
   - 再开主体 → 点「连接主体」
3. 保持页面在前台、屏幕亮着（页面会自动申请常亮）。切走或锁屏会断开

**电脑 Python**

```bash
pip install bleak requests
# Windows：set ；Mac / Linux：export
set BRIDGE_URL=https://xxx.up.railway.app
set BRIDGE_SECRET=你的密码
python bridge.py
```

会自动连上所有 SL278K，并按广播里的产品编号（128 主体 / 129 吸头）认设备。用之前关掉手机蓝牙和官方 App，否则设备会被占住。

### 3. Claude.ai 连接器

Settings → Connectors → 添加自定义连接器，地址：

```
https://xxx.up.railway.app/mcp/你的密码
```

OAuth、Client ID 都留空。**改了服务器代码后**：等 Railway 部署成功 → 断开再连接连接器 → 开新对话，新指令才会出现（旧对话会缓存旧的指令列表）。

> ⚠️ 连接器地址里含密码，不要分享。

---

## 二、指令

| 指令 | 作用 |
|------|------|
| `toy_suck` | 吸头吮吸，模式 1-5 + 强度 |
| `toy_vibrate` | 主体震动花样，1-10 + 强度 |
| `toy_stretch` | 主体伸缩，1-7 + 强度 |
| `toy_set_speed` | 整体强度 0-1（两个设备都响应） |
| `toy_heat` | 加热，主体 / 吸头 / 两个，到时自动关（默认 15 分钟，最多 30） |
| `toy_sequence` | 节奏序列：一段段排好模式、强度、时长，服务器按时间切换，可循环 |
| `toy_stop` | 全部停止，包括加热 |
| `toy_status` | 中继是否在线、正在跑的序列、加热剩余时间 |

**吮吸 5 个模式**（对照官方 App 实测）：

| 模式 | 节奏 |
|------|------|
| 1 | 持续不间断 |
| 2 | 连续 + 断续一下 |
| 3 | 间隔连续 |
| 4 | 只断续 |
| 5 | 断续与连续交替 |

强度低于约 5/10 时，模式之间差别不明显。

**安全上限**：任何序列最多跑 30 分钟自动停；加热最多 30 分钟自动关；说「停」全部关掉。

---

## 三、SL278K 协议

来源：[Buttplug 论坛逆向帖](https://discuss.buttplug.io/t/svakom-sl278k-fatima-plus-not-recognized-by-intiface-central-v3-0-1/867)，吮吸模式与加热通道经实测确认。

- 两个独立蓝牙设备，各自 MAC：productCode 128 = 主体 `SL278K_V`，129 = 吸头 `SL278K_S`
- 控制通道：服务 `FFE0` / 特征 `FFE1`（write without response）
- **⚠️ 不要写 `AE00/AE01`**，那是固件 OTA 口，写错可能变砖
- 连上后约 240ms 发初始化握手：`55 04 00 00 01 FF AA` → `55 04 00 00 00 00 AA` ×2 → `55 03 00 00 00 00 00`

| 功能 | 指令 | 模式 | 强度 | 发给 |
|------|------|------|------|------|
| 震动 | `55 03 00 00 <模式> <强度> 00` | 1-10 | 1-10 | 主体 |
| 伸缩 | `55 08 00 00 <模式> <强度> 00` | 1-7 | 1-10 | 主体 |
| 吮吸 | `55 09 00 00 <模式> <强度> 00` | 1-5 | 1-10 | 吸头 |
| 关闭 | 同上，模式和强度填 `00` | | | |
| 整体强度 | `55 04 00 00 01 <0-255> AA` | | | 两个 |
| 加热开 | `55 05 01 37 <通道> 00 00` | | | 吸头通道 `01`（实测）；主体待测，默认 `02` |
| 加热关 | `55 05 00 00 <通道> 00 00` | | | |

---

## 四、踩坑记录

| 现象 | 原因 | 解决 |
|------|------|------|
| Claude 连不上连接器 | `/mcp` 不是标准 JSON-RPC，缺 `initialize` | 按 MCP 规范实现握手和回复格式 |
| 连接器卡在「需要重新连接」 | 服务器回 401，Claude 以为要 OAuth | 密码错回 404；密码写进路径 `/mcp/<密码>` |
| 新加的指令 Claude 看不到 | 对话缓存了旧指令列表 | 部署成功后重连连接器、开新对话 |
| 吮吸指令没反应 | SL278K 是两个设备，中继只连了主体；吮吸指令要 7 字节 | 两个都连，按设备分发 |
| 吮吸 2、3 模式和 1 一样 | 每 1.5 秒重发模式指令，设备节奏被重置 | **模式指令只发一次**，只有整体强度续命 |
| 换模式中间有停顿 | 换模式前先关再开 | 直接发新模式即可 |
| 加热不热 | 通道号不对 / 指令没发到那个设备 | 吸头用通道 1；用「连接吸头」按钮连 |
| 手机息屏断开 | 浏览器被挂起 | 页面自动 Wake Lock，手机插电并保持亮屏 |
| 扫不到设备 | 官方 App 或另一个中继占着连接 | 一次只开一个中继，关掉官方 App |

---

## 五、文件

| 文件 | 用途 |
|------|------|
| `index.js` | Railway 服务器：MCP 接口、指令队列、节奏序列、加热计时 |
| `relay.html` | 手机网页中继（由服务器在 `/relay` 提供） |
| `bridge.py` | 电脑 Python 中继 |
| `scan.py` | 列出设备的 GATT 服务和特征 |
| `test.py` / `sustaintest.py` | 旧型号 SL278H 的指令和续命测试脚本 |

---

## 附：旧型号 SL278H

本项目最早基于分欣 Plus 的 SL278H 版本逆向（jadx 反编译官方 APK 找 `PROTOCOL_HEADER = 0x55`、`CMD_SCALE = 4`、`CMD_VIBRATE = 3`，再用 nRF Connect 验证 FFE1 通道）。SL278H 和 SL278K 的区别：

- SL278H 实测两件共用一个蓝牙连接；SL278K 是两个独立设备
- SL278H 需要每 1.5 秒续命，否则自动停；SL278K 的模式指令不能续命（见踩坑记录）
- SL278H 振动花样 8 种、档位 1-5；SL278K 震动 10 种、强度 1-10

用 SL278H 的话，`test.py` 和 `sustaintest.py` 还能用来验证。

---

## 致谢

- **吱吱 & Veille**：SVAKOM BLE 逆向社区记录，确认了 FFE0/FFE1 控制通道和 AE00/AE01 OTA 通道的区别
- **Buttplug 社区**：SL278K 协议逆向数据
- nRF Connect 社区的 BLE 抓包分析方法
