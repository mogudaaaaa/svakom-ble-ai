# SVAKOM SL278H · BLE 逆向 + AI 远程控制完整教程

> 从零逆向蓝牙协议，搭建 AI 远程控制系统。  
> 本文基于 SVAKOM 分欣 Plus（SL278H）实测，其他型号方法论通用，具体指令需自行验证。

---

## 目录

1. [逆向工程](#第一部分逆向工程)
2. [系统架构](#第二部分系统架构)
3. [两种连接方式](#第三部分两种连接方式)
4. [设备能力](#第四部分设备能力)
5. [踩坑记录](#第五部分踩坑记录)
6. [常见问题 & 平台适配](#第六部分常见问题--平台适配)
7. [用 Claude.ai 直接控制（MCP 接入）](#第七部分用-claudeai-直接控制mcp-接入)
8. [部署指南](#第八部分部署指南)
9. [致谢](#致谢)

---

## 第一部分：逆向工程

### 1.1 获取 APK

jadx 逆向的前提是拿到 APK 文件：

**方法一：从自己手机导出（最安全）**
1. 手机安装 SVAKOM 官方 App
2. 用「MT管理器」或「ES文件浏览器」找到 APK 路径（通常在 `/data/app/` 下）
3. 复制到电脑

**方法二：APKPure / APKMirror**  
搜索「SVAKOM」下载，选和手机 App 相同的版本号。

> ⚠️ 只用于反编译分析，不要把来路不明的 APK 安装到手机上。

---

### 1.2 反编译 APK 找协议

工具：[jadx-gui](https://github.com/skylot/jadx)（免费，Windows / Mac / Linux）

**操作步骤：**
1. jadx-gui 打开 APK
2. 左边包结构找 `com.svakom` 开头的包
3. Ctrl+F 搜索 `PROTOCOL_HEADER` 或 `0x55` 或 `CMD_`
4. 找到命令定义类，同一个类里通常有所有 `CMD_` 常量
5. 找 `sendCommand(byte[] data)` 之类的方法，追踪调用方式——这就是完整命令格式

发现的关键常量：

| 常量 | 值 | 说明 |
|------|----|------|
| `PROTOCOL_HEADER` | `0x55` | 每条命令的开头字节 |
| `CMD_SCALE` | `4` | 强度控制 |
| `CMD_VIBRATE` | `3` | 振动花样 |

**tail 字节怎么确定的（`0xAA` vs `0x00`）：**  
直接从 APK 构造命令的代码里读出来。强度命令最后一个字节是 `0xAA`，振动花样是 `0x00`。不同命令的 tail 可能不同，逐一确认，不能统一。

---

### 1.3 找正确的 BLE 通道

工具：nRF Connect（手机 App）

扫描设备后会看到两个写入通道——**用错一个可能变砖**：

| 通道 | 用途 | 能不能写 |
|------|------|---------|
| `FFE0` 服务 / `FFE1` 特征 | 控制通道 | ✅ 正确 |
| `AE00` 服务 / `AE01` 特征 | 固件 OTA 刷机口 | ⚠️ 变砖风险！ |

**如何确认 AE01 危险（不要实测）：**
- APK 反编译代码里 AE 服务对应固件升级流程
- BLE 社区文档明确标注
- nRF Connect 里 AE01 特征描述包含「OTA」字样

**验证 FFE1 是正确通道：**  
nRF Connect 连上设备 → FFE1 特征 → Write → 输入 `55 04 00 00 01 B4 AA` → 设备有响应即确认。

---

### 1.4 如何发现 BLE 服务结构

不要靠猜，用工具扫出来：

**方法一：nRF Connect**（最直观）
1. 连上设备，点进去看所有服务列表
2. 展开每个服务，记录所有特征的 UUID 和属性
3. 有 `Write Without Response` 属性的 → 候选控制通道
4. UUID 带 `AE` 的要小心（通常是 OTA）

**方法二：scan.py**（批量记录）
```bash
python scan.py
```
输出所有服务和特征，重点看：
- 有 `write-without-response` → 候选控制通道
- 有 `notify` → 可监听设备反馈

---

### 1.5 命令格式

所有命令格式：`[0x55, CMD, 0x00, 0x00, 参数1, 参数2, tail]`

**强度控制**（两个设备都响应）：
```
[0x55, 0x04, 0x00, 0x00, 0x01, intensity(0-255), 0xAA]
```

**振动花样**（仅震动棒响应）：
```
[0x55, 0x03, 0x00, 0x00, mode(1-8), level(1-5), 0x00]
```

**停止**：
```
[0x55, 0x04, 0x00, 0x00, 0x00, 0x00, 0xAA]
```

---

### 1.6 续命机制（最重要的发现）

**问题**：发一次命令，设备只动一下就停了。  
**原因**：设备有超时保护，不持续收到命令就自动停止。  
**解决**：每 1.5 秒重发当前命令（keepalive）。

用 `sustaintest.py` 做 A/B 对比验证：
- 测试A：发一次，等 8 秒 → 设备自己停了 ✗
- 测试B：每 1.5s 重发，跑 12 秒 → 持续动 ✓

---

### 1.7 其他发现

**BLE 地址随机旋转**：每次开机地址不同，必须按名字 `SL278H` 扫描，不能用固定地址。

**双设备共用同一 MAC**：两件设备蓝牙地址相同，只能连一个。但两个都开机时，发 `CMD_SCALE` 两个都会响应（硬件联动）。

**如何判断是共用还是独立地址：**  
两个设备都开机 → nRF Connect 扫描 → 只看到一个条目 = 共用；看到两个不同条目 = 各自独立。

**如何发现联动关系：**  
只连其中一个 → 发 `CMD_SCALE` → 观察另一个有没有反应。有 = 硬件联动，可用 `linktest.py` 验证。

---

### 1.8 实测方法论

逆向只给理论，实际能不能用必须测。

**Step 1：nRF Connect 手动验证（排除代码问题）**
1. 连上设备，FFE1 点 Write
2. 输入 `55 04 00 00 01 B4 AA`
3. 有反应 → 通道正确；没反应 → 换通道或查格式

**Step 2：test.py 逐一测试**
- 强度 30% / 60% / 100%
- 花样 1 到 8 各档
- 每条命令间隔 3 秒，记录「命令 → 设备A反应 → 设备B反应」

**Step 3：异常立刻排查**
- 动一下就停 → 缺续命，不是命令错了
- 只有一个设备响应 → 正常，不同命令响应范围不同
- 扫不到设备 → MAC 地址变了，改成名字扫描

**Step 4：A/B 对比验证机制**  
参见 1.6，用 `sustaintest.py` 做严格对比。

**核心原则：每次只改一个变量**  
只改一个字节，其他不动，才能确认哪个字节控制哪个功能。

**测试时复现不了怎么办：**
- 设备没电 → 充满再测
- 手机 App 占住连接 → 关掉官方 App 和手机蓝牙
- MAC 地址变了 → 按名字扫描
- 命令发太快 → 每条间加 `sleep(0.5)`
- 续命干扰测试 → 测试时先停掉 keepalive 循环

---

## 第二部分：系统架构

```
PWA 聊天界面
    ↓ HTTPS
Next.js 服务端（解析隐藏指令）
    ↓
Railway 中继服务器（内存队列）
    ↓ HTTP 轮询（每 300ms）
BLE 中继（手机网页 or 电脑 Python）
    ↓ BLE write-without-response（FFE1）
设备
```

AI 在回复中嵌入隐藏指令，服务端截取并转发，用户不可见：

```
[TOY:{"speed":0.5}]              强度 50%，持续
[TOY:{"speed":0.8,"sec":20}]     强度 80%，20 秒后自动停
[TOY:{"pattern":3,"level":0.7}]  振动花样3，强度70%（仅震动棒）
[TOY:{"stop":true}]              立即停止
```

---

## 第三部分：两种连接方式

### 方式 A：安卓手机网页中继（推荐）

利用 Web Bluetooth API，手机浏览器直接连蓝牙。

**优点**：不需要开电脑，手机放设备旁（< 1m），稳定不断连。  
**限制**：需要安卓手机 + Chrome / Edge（iOS 不支持 Web Bluetooth）。

**一次性准备：**
1. 手机插充电器
2. 「开发者选项 → 充电时保持唤醒状态」打开
3. 息屏时间调最长

**每次使用：**
1. 开设备
2. 手机 Chrome 打开 toy.html（下载后本地打开，或托管到任意静态服务）
3. 在「中继地址」输入框填入你的 Railway 地址：`https://你的地址.up.railway.app/toy-next`
4. 点「连接玩具」，弹窗选 SL278H，看到「✅ 就绪」
5. 手机放设备旁，屏幕保持亮着

> ⚠️ 切换 App 或锁屏会导致蓝牙断开。

---

### 方式 B：Windows / Mac / Linux 电脑 Python 中继

**优点**：不需要额外手机。  
**限制**：电脑需在附近（BLE 约 3-4m），使用前关手机蓝牙。

**安装：**
```bash
pip install bleak requests
```

**设置环境变量后运行：**
```bash
# Windows
set BRIDGE_URL=https://你的地址.up.railway.app
set BRIDGE_SECRET=你设的密码
python bridge.py

# Mac / Linux
export BRIDGE_URL=https://你的地址.up.railway.app
export BRIDGE_SECRET=你设的密码
python3 bridge.py
```

或者新建 `start.bat`（Windows 一键启动）：
```bat
@echo off
set BRIDGE_URL=https://你的地址.up.railway.app
set BRIDGE_SECRET=你设的密码
python bridge.py
pause
```

> ⚠️ 黑色窗口最小化，不要关。使用前关掉手机蓝牙，否则手机会占住设备连接。

---

## 第四部分：设备能力

> 以下为 SVAKOM 分欣 Plus（SL278H）实测结果，其他型号请自行用 test.py 验证。

| 设备 | CMD_SCALE（强度 0-100%） | CMD_VIBRATE（花样 1-8） |
|------|------------------------|----------------------|
| 吮吸款 | 震动强度 | 不响应 |
| 震动棒 | 伸缩抽插速度 | 8 档振动花样 |
| 两个都开 | 两个同时响应 | 仅震动棒响应 |

---

### SL278K（分欣 Plus / FATIMA PLUS）

协议来源：[Buttplug 论坛逆向帖](https://discuss.buttplug.io/t/svakom-sl278k-fatima-plus-not-recognized-by-intiface-central-v3-0-1/867)

SL278K 是**两个独立的蓝牙设备**，名字都叫 SL278K，MAC 不同：主体 `SL278K_V`（震动 + 伸缩）和吸头 `SL278K_S`（吮吸）。中继要两个都连上（手机网页点「再连一个设备」，bridge.py 会自动全连），指令广播给两个，各自只响应自己的。

连上后约 240ms 要先发初始化握手：`55 04 00 00 01 FF AA` → `55 04 00 00 00 00 AA` ×2 → `55 03 00 00 00 00 00`。

| 功能 | 指令 | 模式 | 强度 | 设备 |
|------|------|------|------|------|
| 震动 | `55 03 00 00 <模式> <强度> 00` | 1-10 | 1-10 | 主体 |
| 伸缩 | `55 08 00 00 <模式> <强度> 00` | 1-7 | 1-10 | 主体 |
| 吮吸 | `55 09 00 00 <模式> <强度> 00` | 1-5 | 1-10 | 吸头 |
| 关闭 | 同上，模式和强度填 `00` | | | |
| 加热开 | `55 05 01 37 <通道> 00 00` | | | 通道默认 `02`（待实测） |
| 加热关 | `55 05 00 00 <通道> 00 00` | | | |

吮吸 5 个模式（实测，对应官方 App）：1 持续不间断 · 2 连续 + 断续一下 · 3 间隔连续 · 4 只断续 · 5 断续与连续交替。

**SL278K 的模式指令不要续命。** 每 1.5 秒重发会让设备的节奏从头开始，有间隔的模式会一直卡在开头那段，表现成全是持续或全是断续。模式指令只发一次就会一直跑；整体强度（`55 04`）照旧续命。强度低于约 5/10 时模式之间差别不明显。

---

## 第五部分：踩坑记录

| 坑 | 现象 | 原因 | 解决 |
|----|------|------|------|
| 写入通道错误 | 无响应 | 命令发到 AE01（OTA 口） | 改用 FFE1 |
| BLE 库编译失败 | C++ 报错 | Node 24 不兼容 | 改用 Python + bleak |
| WebSocket 断连 | fragmented control frame | Railway 代理不支持 WS 分帧 | 改用 HTTP 轮询 |
| 发一次就停 | 动一下就停 | 设备超时保护 | 每 1.5s 续命重发 |
| BLE 地址变化 | 重启后连不上 | MAC 随机旋转 | 按名字扫描 |
| 蓝牙距离短 | 3-4m 就断 | BLE 距离限制 | 手机放旁边做中继 |
| 手机息屏断开 | 屏幕黑后停止 | 浏览器被系统挂起 | Wake Lock + 充电保持唤醒 |

---

## 第六部分：常见问题 & 平台适配

### Q1：只有一个设备怎么办？

完全没问题：
- 只有吮吸款：`speed` 控制震动强度，`pattern` 无效
- 只有震动棒：`speed` 控制伸缩速度，`pattern` 控制振动花样

### Q2：两个设备名字/地址不一样？

说明你的型号是各自独立地址，可以分别连接独立控制。用 `scanall.py` 列出所有设备名和地址，修改 `bridge.py` 里的扫描逻辑按名字区分。

### Q3：扫描到了但连接失败？

- 设备被手机 App 占用 → 关掉官方 App 和手机蓝牙
- 设备没电 → 充电后重试
- 距离太远 → 靠近后重试
- Windows 蓝牙驱动问题 → 设备管理器里禁用再启用蓝牙适配器

### Q4：命令发出去但设备没反应？

1. `scan.py` 确认 FFE1 特征存在
2. nRF Connect 手动写 `55 04 00 00 01 B4 AA` 验证通道
3. 确认没写到 AE01
4. 换 USB 蓝牙适配器试试

### Q5：电脑和手机怎么切换？

两个中继不能同时运行（会抢占设备连接）。先停掉一个，再启动另一个。

### Q6：连上后过一会儿自动断开？

- 电脑：关闭「允许计算机关闭此设备以节约电源」
- 手机：确认屏幕常亮，不切换 App
- 通用：设备没电也会断开

### Q7：BLE 距离怎么自测？

运行 `bridge.py` 连上设备后，手持电脑慢慢远离，出现「写入失败」就是超距了。我们实测：同一房间无遮挡约 3-4m 开始不稳定，有墙壁更短。推荐手机放床边距离 < 1m。

### Q8：能同时控制两个独立地址的设备吗？

可以，修改 `bridge.py` 启动两个 `BleakClient` 并行连接，各自维护写入句柄，收到指令后同时发送。参考 `bridge.py` 里的 `ble_loop` 自行扩展。

---

### 平台适配

**Windows（推荐）**
```bash
pip install bleak requests
python bridge.py
```
要求：Windows 10 1903+ / Windows 11，内置蓝牙或 USB 蓝牙适配器。  
bleak 安装失败：确认 Python 已加入 PATH，用管理员权限运行。

**macOS**
```bash
pip3 install bleak requests
python3 bridge.py
```
要求：macOS 10.15+，首次运行弹窗请求蓝牙权限点「允许」。  
M 系列 Mac：「系统设置 → 隐私与安全 → 蓝牙」里手动允许终端。

**Linux**
```bash
pip3 install bleak requests
sudo python3 bridge.py
```
安装 BlueZ（Ubuntu / Debian）：
```bash
sudo apt install bluetooth bluez
sudo systemctl start bluetooth
sudo usermod -a -G bluetooth $USER
```

**安卓（网页中继）**  
支持：Chrome 56+ / Edge（Chromium）  
不支持：Firefox、微信内置浏览器、QQ浏览器

**iOS / iPhone**  
Web Bluetooth API 在 iOS Safari 上不受支持。替代方案：借安卓手机，或用电脑运行 `bridge.py`。

---

## 第七部分：用 Claude.ai 直接控制（MCP 接入）

不需要搭建 PWA，Claude.ai 账号 + Railway 部署即可让 AI 控制设备。

### 原理

Railway 上运行 MCP Server，Claude.ai 通过 Integrations 连接，聊天时可直接调用：
- `toy_set_speed` — 设置强度
- `toy_set_pattern` — 设置振动花样
- `toy_stop` — 停止
- `toy_status` — 查询中继是否在线

### 步骤

**第一步：部署 Railway bridge**（见[第八部分](#第八部分部署指南)）

**第二步：启动蓝牙中继**（选一种）

手机网页：Chrome 打开 toy.html，中继地址填 `https://你的地址.up.railway.app/toy-next`

电脑：
```bash
set BRIDGE_URL=https://你的地址.up.railway.app
set BRIDGE_SECRET=你设的密码
python bridge.py
```

**第三步：Claude.ai 添加 MCP Integration**

1. claude.ai → Settings → Integrations → Add Integration
2. URL 填：`https://你的地址.up.railway.app/mcp?secret=你设的密码`
3. 保存

**第四步：开始使用**

新建对话，告诉 Claude：
```
我有一个 SVAKOM 振动玩具通过蓝牙连接到了 MCP 工具里。
你可以用 toy_set_speed、toy_set_pattern、toy_stop 来控制它。
先用 toy_status 确认是否在线，然后我们开始。
```

之后直接说「开到 50%」「换个花样」「停一下」，Claude 会自动调用工具。

> ⚠️ MCP URL 里含有 secret，不要分享给别人。

---

## 第八部分：部署指南

### 8.1 Railway bridge 部署

**第一步：准备仓库**

Fork 本仓库，确保包含：
- `bridge/index.js`
- `package.json`：

```json
{
  "name": "svakom-bridge",
  "type": "module",
  "scripts": { "start": "node bridge/index.js" },
  "dependencies": {
    "express": "^4.18.0",
    "ws": "^8.0.0"
  }
}
```

**第二步：Railway 部署**

1. 注册 [railway.app](https://railway.app)（GitHub 账号登录）
2. New Project → Deploy from GitHub Repo → 选你的仓库
3. Railway 自动检测 `package.json` 并部署

**第三步：设置环境变量**

Railway 项目 → Variables：

| 变量名 | 说明 |
|--------|------|
| `BRIDGE_SECRET` | 自己设一个密码，如 `abc123xyz` |

**第四步：拿到地址**

Settings → Networking → Public Domain，格式：  
`https://svakom-bridge-production.up.railway.app`

这就是你的 `BRIDGE_URL`。

---

### 8.2 bridge.py 配置

`bridge.py` 通过环境变量读取 Railway 地址（见第三部分）。  
也可以直接改代码第一行：
```python
BRIDGE_URL = "https://你的地址.up.railway.app"
BRIDGE_SECRET = "你设的密码"
```

---

### 8.3 适配其他 SVAKOM 型号 / 其他品牌

**设备名不是 SL278H：**  
修改 `bridge.py` 和 `scan.py` 里的扫描条件：
```python
# 改成你的设备名
dev = next((d for d in devs if d.name and "你的设备名" in d.name), None)
```

**完全不同品牌：**  
协议可能完全不同，需重新 jadx 逆向。方法论一样：jadx → nRF Connect 验证 → test.py 批量测试。

---

## 诊断脚本

| 脚本 | 用途 |
|------|------|
| `scan.py` | 列出所有 GATT 服务和特征 |
| `scanall.py` | 扫描附近所有 SL278H 设备 |
| `test.py` | 测试各种命令（强度、花样等） |
| `sustaintest.py` | 对比有无续命的效果 |
| `linktest.py` | 测试双设备联动 |

---

## ⚠️ 安全说明

`AE00/AE01` 是固件 OTA 升级通道，写入任何数据都可能导致设备**永久变砖**。  
控制通道固定为 `FFE0` 服务下的 `FFE1` 特征（write-without-response）。

---

## 致谢

- **吱吱 & Veille**：SVAKOM BLE 逆向社区记录，确认了 FFE0/FFE1 控制通道和 AE00/AE01 OTA 通道的区别
- nRF Connect 社区的 BLE 抓包分析方法

本项目在此基础上补充了：续命机制的发现与验证、双设备联动逻辑、完整 AI 控制系统架构、MCP 接入方案。

---

*最后更新：2026-06-15*
