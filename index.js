import express from "express";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// 允许从其他来源打开的中继网页访问（例如本地打开的 relay.html）
// 没有这段，浏览器预检 OPTIONS 会被 404 挡掉，中继请求根本到不了 /toy-next
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "content-type, x-bridge-secret");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// 手机网页中继：安卓 Chrome 打开 https://你的地址/relay
app.get("/relay", (req, res) => res.sendFile(path.join(__dirname, "relay.html")));

const SECRET = process.env.BRIDGE_SECRET || "change-me";
const PORT = process.env.PORT || 3000;
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// 简单内存队列，存最新一条指令
let currentCmd = null;
let lastUpdate = 0;
let lastPoll = 0; // 中继最后一次来取指令的时间，用来判断是否在线

function pushCmd(cmd) {
  currentCmd = cmd;
  lastUpdate = Date.now();
}

// 加热单独一个队列，不会被震动/吮吸指令覆盖掉；主体和吸头分开计时
const heatQueue = [];
const HEAT_MAX_MIN = 30;
const heat = {
  body: { on: false, idx: 2, until: 0, timer: null },
  sucker: { on: false, idx: 2, until: 0, timer: null }
};
const HEAT_NAME = { body: "主体", sucker: "吸头" };
// 实测：吸头加热通道是 1；主体还没测，先用 2
const HEAT_IDX = { body: 2, sucker: 1 };

function setHeat(target, on, idxOverride, minutes) {
  const parts = target === "body" || target === "sucker" ? [target] : ["body", "sucker"];
  let min = 0;
  for (const t of parts) {
    const idx = idxOverride ?? HEAT_IDX[t];
    if (heat[t].timer) clearTimeout(heat[t].timer);
    heat[t] = { on, idx, until: 0, timer: null };
    if (on) {
      min = clamp(Number(minutes) || 15, 1, HEAT_MAX_MIN);
      heat[t].until = Date.now() + min * 60000;
      heat[t].timer = setTimeout(() => setHeat(t, false, idx), min * 60000);
    }
    // 每个设备通道号可能不同，所以分开发
    heatQueue.push({ type: "heat", on, idx, target: t, at: Date.now() });
  }
  return min;
}
const anyHeat = () => heat.body.on || heat.sucker.on;

// ---------------- 节奏序列（服务器按时间一步步切换指令） ----------------

const MAX_STEPS = 60;
const MIN_STEP_SEC = 0.5;
const MAX_RUN_SEC = 30 * 60; // 安全上限：任何序列最多跑 30 分钟就自动停
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let seq = null; // { name, steps, loop, idx, round, timer, startedAt }

function normalizeStep(st) {
  const sec = clamp(Number(st.sec) || 0, MIN_STEP_SEC, 600);
  if (st.stop || st.speed === 0) return { kind: "pause", sec };
  if (st.stretch !== undefined) {
    return {
      kind: "stretch",
      mode: clamp(Math.round(Number(st.stretch) || 1), 1, 7),
      level: clamp(Number(st.level ?? 0.6), 0, 1),
      sec
    };
  }
  if (st.suck !== undefined) {
    return {
      kind: "suck",
      mode: clamp(Math.round(Number(st.suck) || 1), 1, 5),
      level: clamp(Number(st.level ?? 0.6), 0, 1),
      sec
    };
  }
  const vib = st.vibrate ?? st.pattern;
  if (vib !== undefined) {
    return {
      kind: "pattern",
      pattern: clamp(Math.round(Number(vib) || 1), 1, 10),
      level: clamp(Number(st.level ?? 0.7), 0, 1),
      sec
    };
  }
  return { kind: "speed", speed: clamp(Number(st.speed) || 0, 0, 1), sec };
}

function stepToCmd(st) {
  if (st.kind === "pause") return { type: "stop" };
  if (st.kind === "stretch") return { type: "stretch", mode: st.mode, level: st.level };
  if (st.kind === "suck") return { type: "suck", mode: st.mode, level: st.level };
  if (st.kind === "pattern") return { type: "pattern", pattern: st.pattern, level: st.level };
  return { type: "speed", speed: st.speed };
}

function cancelSeq() {
  if (seq?.timer) clearTimeout(seq.timer);
  seq = null;
}

function runStep() {
  if (!seq) return;
  if (seq.idx >= seq.steps.length) {
    seq.round++;
    const more = seq.loop === true || (typeof seq.loop === "number" && seq.round < seq.loop);
    if (!more) { cancelSeq(); return pushCmd({ type: "stop" }); }
    seq.idx = 0;
  }
  if ((Date.now() - seq.startedAt) / 1000 > MAX_RUN_SEC) {
    cancelSeq(); return pushCmd({ type: "stop" });
  }
  const st = seq.steps[seq.idx++];
  pushCmd(stepToCmd(st));
  seq.timer = setTimeout(runStep, st.sec * 1000);
}

function startSeq(name, rawSteps, loop) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new Error("steps 不能为空");
  if (rawSteps.length > MAX_STEPS) throw new Error(`steps 最多 ${MAX_STEPS} 步`);
  cancelSeq();
  seq = { name, steps: rawSteps.map(normalizeStep), loop: loop ?? false, idx: 0, round: 0, timer: null, startedAt: Date.now() };
  runStep();
  const one = seq ? seq.steps.reduce((a, b) => a + b.sec, 0) : 0;
  return one;
}

function checkSecret(req, res, next) {
  const secret = req.params.secret || req.query.secret || req.headers["x-bridge-secret"];
  if (secret !== SECRET) {
    // 回 404 而不是 401：401 会让 Claude.ai 以为需要 OAuth 登录，连接器就会卡在「需要重新连接」
    return res.status(404).json({ error: "not found" });
  }
  next();
}

// 中继轮询：获取下一条指令
app.get("/toy-next", checkSecret, (req, res) => {
  lastPoll = Date.now();
  while (heatQueue.length) {
    const h = heatQueue.shift();
    if (Date.now() - h.at < 60000) return res.json({ type: "heat", on: h.on, idx: h.idx, target: h.target });
  }
  if (currentCmd && Date.now() - lastUpdate < 15000) {
    const cmd = currentCmd;
    currentCmd = null;
    return res.json(cmd);
  }
  res.json({ type: "hello" });
});

// ---------------- MCP（Streamable HTTP + JSON-RPC 2.0） ----------------

const TOOLS = [
  {
    name: "toy_set_speed",
    description: "设置整体强度 (0.0-1.0)，不区分功能",
    inputSchema: {
      type: "object",
      properties: {
        speed: { type: "number", description: "0.0 ~ 1.0" },
        sec: { type: "number", description: "持续秒数，可选" }
      },
      required: ["speed"]
    }
  },
  {
    name: "toy_vibrate",
    description: "设置主体的震动花样（10 种）和强度",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "number", description: "震动花样 1-10，默认 1" },
        level: { type: "number", description: "强度 0-1，默认 0.7" },
        sec: { type: "number", description: "持续秒数，可选" }
      }
    }
  },
  {
    name: "toy_suck",
    description: "设置吸头的吮吸模式和强度。模式：1=持续不间断，2=连续+断续一下，3=间隔连续，4=只断续，5=断续与连续交替。模式指令只发一次，设备自己跑节奏",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "number", description: "吮吸模式 1-5（1=持续不间断，2=连续+断续一下，3=间隔连续，4=只断续，5=断续与连续交替），默认 1" },
        level: { type: "number", description: "强度 0-1，默认 0.6" },
        sec: { type: "number", description: "持续秒数，可选" }
      }
    }
  },
  {
    name: "toy_stretch",
    description: "设置主体的伸缩模式（7 种）和强度",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "number", description: "伸缩模式 1-7，默认 1" },
        level: { type: "number", description: "强度 0-1，默认 0.6" },
        sec: { type: "number", description: "持续秒数，可选" }
      }
    }
  },
  {
    name: "toy_heat",
    description: "开关加热。主体和吸头各有一个加热，可以分开开关。打开后到时间自动关（默认 15 分钟，最多 30 分钟）。toy_stop 会关掉所有加热",
    inputSchema: {
      type: "object",
      properties: {
        on: { type: "boolean", description: "true 开，false 关" },
        target: { type: "string", enum: ["body", "sucker", "both"], description: "body = 主体，sucker = 吸头，both = 两个，默认 both" },
        minutes: { type: "number", description: "开多久后自动关，默认 15，最多 30" },
        idx: { type: "number", description: "加热通道号，一般不填（吸头 1，已实测；主体默认 2，待实测）。只在测主体加热时换着试" }
      },
      required: ["on"]
    }
  },
  {
    name: "toy_stop",
    description: "立即停止所有功能（包括加热）",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "toy_status",
    description: "查询中继是否在线，以及当前是否在跑序列",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "toy_sequence",
    description: "按节奏自动切换模式和强度（例如强弱交替、渐强、停顿再加强）。服务器按时间自动推进，跑完自动停。发其他控制指令或 toy_stop 会打断当前序列。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "给这段节奏起个名字，可选" },
        steps: {
          type: "array",
          description: "按顺序执行的步骤。每步填一种：suck（1-5，吸头吮吸模式）、vibrate（1-10，主体震动花样）、stretch（1-7，主体伸缩模式）或 speed（0-1，整体强度）；前三种配 level 0-1；再填 sec（这一步持续几秒，最少 0.5）。speed 为 0 表示停顿。最多 60 步。",
          items: {
            type: "object",
            properties: {
              speed: { type: "number", description: "强度 0-1；0 = 停顿" },
              vibrate: { type: "number", description: "主体震动花样 1-10（配 level）" },
              suck: { type: "number", description: "吸头吮吸模式 1-5（1=持续不间断，2=连续+断续一下，3=间隔连续，4=只断续，5=断续与连续交替），配 level" },
              stretch: { type: "number", description: "主体伸缩模式 1-7（配 level）" },
              level: { type: "number", description: "模式强度 0-1；吮吸低于 0.5 时模式差别不明显" },
              sec: { type: "number", description: "这一步持续秒数" }
            },
            required: ["sec"]
          }
        },
        loop: { description: "true = 一直循环直到叫停（最多 30 分钟）；数字 = 重复几轮；不填 = 只跑一轮", anyOf: [{ type: "boolean" }, { type: "number" }] }
      },
      required: ["steps"]
    }
  },
];

const text = (t) => ({ content: [{ type: "text", text: t }] });

function callTool(name, args) {
  switch (name) {
    case "toy_set_speed": {
      cancelSeq();
      const speed = clamp(Number(args.speed) || 0, 0, 1);
      pushCmd({ type: "speed", speed, sec: Number(args.sec) || 0 });
      return text(`已设置强度 ${speed}`);
    }
    case "toy_vibrate": {
      cancelSeq();
      const mode = clamp(Math.round(Number(args.mode ?? args.pattern) || 1), 1, 10);
      const level = clamp(Number(args.level ?? 0.7), 0, 1);
      pushCmd({ type: "pattern", pattern: mode, level, sec: Number(args.sec) || 0 });
      return text(`已设置震动花样 ${mode}，强度 ${level}`);
    }
    case "toy_suck": {
      cancelSeq();
      const mode = clamp(Math.round(Number(args.mode) || 1), 1, 5);
      const level = clamp(Number(args.level ?? 0.6), 0, 1);
      pushCmd({ type: "suck", mode, level, sec: Number(args.sec) || 0 });
      return text(`已设置吮吸模式 ${mode}，强度 ${level}`);
    }
    case "toy_stretch": {
      cancelSeq();
      const mode = clamp(Math.round(Number(args.mode) || 1), 1, 7);
      const level = clamp(Number(args.level ?? 0.6), 0, 1);
      pushCmd({ type: "stretch", mode, level, sec: Number(args.sec) || 0 });
      return text(`已设置伸缩模式 ${mode}，强度 ${level}`);
    }
    case "toy_heat": {
      const idx = args.idx === undefined ? undefined : clamp(Math.round(Number(args.idx)), 0, 255);
      const target = args.target === "body" || args.target === "sucker" ? args.target : "both";
      const where = target === "both" ? "主体和吸头" : HEAT_NAME[target];
      if (args.on) {
        const min = setHeat(target, true, idx, args.minutes);
        return text(`已打开${where}加热，${min} 分钟后自动关`);
      }
      setHeat(target, false, idx);
      return text(`已关闭${where}加热`);
    }
    case "toy_stop":
      cancelSeq();
      pushCmd({ type: "stop" });
      if (anyHeat()) { setHeat("both", false); return text("已停止，加热也已关闭"); }
      return text("已停止");
    case "toy_status": {
      const ago = lastPoll ? Math.round((Date.now() - lastPoll) / 1000) : null;
      const online = ago !== null && ago < 5;
      const heatInfo = ["body", "sucker"].filter((t) => heat[t].on)
        .map((t) => `\n${HEAT_NAME[t]}加热开着，还有约 ${Math.ceil((heat[t].until - Date.now()) / 60000)} 分钟自动关`).join("");
      const seqInfo = seq ? `\n正在运行序列「${seq.name}」：第 ${seq.round + 1} 轮，第 ${seq.idx}/${seq.steps.length} 步` : "";
      return text((
        online
          ? `中继在线（${ago} 秒前轮询）`
          : ago === null
            ? "中继离线：服务启动后还没有中继来轮询"
            : `中继离线：最后一次轮询在 ${ago} 秒前`
      ) + seqInfo + heatInfo);
    }
    case "toy_sequence": {
      const loop = args.loop ?? false;
      const one = startSeq(args.name || "临时序列", args.steps, loop);
      const loopText = loop === true ? "，循环直到叫停（最多 30 分钟）" : typeof loop === "number" && loop > 1 ? `，重复 ${loop} 轮` : "";
      return text(`已开始序列「${args.name || "临时序列"}」：${args.steps.length} 步，一轮约 ${one.toFixed(1)} 秒${loopText}`);
    }
    default:
      return null;
  }
}

function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  if (isNotification) return null; // notifications/initialized 等，不需要回复

  switch (method) {
    case "initialize": {
      const wanted = params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "svakom-bridge", version: "2.0.0" }
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      try {
        const result = callTool(params?.name, params?.arguments || {});
        return result ? ok(result) : err(-32602, `unknown tool: ${params?.name}`);
      } catch (e) {
        return ok({ isError: true, content: [{ type: "text", text: `出错了：${e.message}` }] });
      }
    }
    default:
      return err(-32601, `method not found: ${method}`);
  }
}

app.post(["/mcp", "/mcp/:secret"], checkSecret, (req, res) => {
  const body = req.body;
  if (Array.isArray(body)) {
    const replies = body.map(handleRpc).filter(Boolean);
    return replies.length ? res.json(replies) : res.status(202).end();
  }
  const reply = handleRpc(body);
  if (!reply) return res.status(202).end();
  res.json(reply);
});

// 不提供 SSE 推送流
app.get(["/mcp", "/mcp/:secret"], checkSecret, (req, res) => res.status(405).set("Allow", "POST").end());
app.delete(["/mcp", "/mcp/:secret"], checkSecret, (req, res) => res.status(405).set("Allow", "POST").end());

app.get("/", (req, res) => res.send("SVAKOM Bridge is running"));

app.listen(PORT, () => console.log(`Bridge running on port ${PORT}`));
