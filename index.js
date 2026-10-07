import express from "express";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// 允许从其他来源打开的中继网页访问（本地 toy.html、别的静态站）
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

// ---------------- 节奏序列（服务器按时间一步步切换指令） ----------------

const MAX_STEPS = 60;
const MIN_STEP_SEC = 0.5;
const MAX_RUN_SEC = 30 * 60; // 安全上限：任何序列最多跑 30 分钟就自动停
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let seq = null; // { name, steps, loop, idx, round, timer, startedAt }
const presets = new Map(); // 内存保存，服务重启会清空

function normalizeStep(st) {
  const sec = clamp(Number(st.sec) || 0, MIN_STEP_SEC, 600);
  if (st.stop || st.speed === 0) return { kind: "pause", sec };
  if (st.suck !== undefined) {
    return {
      kind: "suck",
      mode: clamp(Math.round(Number(st.suck) || 1), 1, 10),
      level: clamp(Number(st.level ?? 0.6), 0, 1),
      sec
    };
  }
  if (st.pattern !== undefined) {
    return {
      kind: "pattern",
      pattern: clamp(Math.round(Number(st.pattern) || 1), 1, 8),
      level: clamp(Number(st.level ?? 0.7), 0, 1),
      sec
    };
  }
  return { kind: "speed", speed: clamp(Number(st.speed) || 0, 0, 1), sec };
}

function stepToCmd(st) {
  if (st.kind === "pause") return { type: "stop" };
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

// 渐变：在 sec 秒内从 from 平滑过渡到 to，拆成若干小步
function rampSteps(from, to, sec) {
  const n = clamp(Math.round(sec / 1), 2, 40);
  const each = Math.max(MIN_STEP_SEC, sec / n);
  return Array.from({ length: n }, (_, i) => ({
    speed: +(from + (to - from) * (i / (n - 1))).toFixed(3),
    sec: each
  }));
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
  if (currentCmd && Date.now() - lastUpdate < 15000) {
    const cmd = currentCmd;
    currentCmd = null;
    return res.json(cmd);
  }
  res.json({ type: "hello" });
});

// 测试用：直接设置指令
app.post("/toy", checkSecret, (req, res) => {
  currentCmd = req.body;
  lastUpdate = Date.now();
  res.json({ ok: true });
});

// ---------------- MCP（Streamable HTTP + JSON-RPC 2.0） ----------------

const TOOLS = [
  {
    name: "toy_set_speed",
    description: "设置强度 (0.0-1.0)",
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
    name: "toy_set_pattern",
    description: "设置振动花样",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "number", description: "1-8" },
        level: { type: "number", description: "0.0-1.0" }
      },
      required: ["pattern"]
    }
  },
  {
    name: "toy_suck",
    description: "设置吮吸款的吮吸模式和强度（指令 0x09）。模式 1 通常是持续吮吸，其他模式需要实测",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "number", description: "吮吸模式 1-10，默认 1" },
        level: { type: "number", description: "强度 0-1，默认 0.6" },
        sec: { type: "number", description: "持续秒数，可选" }
      }
    }
  },
  {
    name: "toy_raw",
    description: "调试用：直接发一条原始 BLE 指令（十六进制，空格分隔），用来实测新指令格式。只允许 55 开头、6-8 字节、指令号 03/04/08/09。默认 sec 秒后自动停",
    inputSchema: {
      type: "object",
      properties: {
        hex: { type: "string", description: "例如 \"55 09 00 00 01 05 00\"" },
        sec: { type: "number", description: "持续秒数，默认 5" }
      },
      required: ["hex"]
    }
  },
  {
    name: "toy_stop",
    description: "立即停止",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "toy_status",
    description: "查询中继是否在线，以及当前是否在跑序列",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "toy_sequence",
    description: "按节奏自动切换强度/花样（例如强弱交替、波浪、停顿再加强）。服务器按时间自动推进，跑完自动停。发 toy_set_speed / toy_set_pattern / toy_stop 会打断当前序列。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "给这段节奏起个名字，可选" },
        steps: {
          type: "array",
          description: "按顺序执行的步骤。每步填 speed（0-1，强度）、pattern（1-8，震动棒花样，配 level 0-1）或 suck（1-10，吮吸模式，配 level 0-1），再填 sec（这一步持续几秒，最少 0.5）。speed 为 0 表示停顿。最多 60 步。",
          items: {
            type: "object",
            properties: {
              speed: { type: "number", description: "强度 0-1；0 = 停顿" },
              pattern: { type: "number", description: "振动花样 1-8（仅震动棒）" },
              suck: { type: "number", description: "吮吸模式 1-10（仅吮吸款，配 level）" },
              level: { type: "number", description: "花样强度 0-1" },
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
  {
    name: "toy_ramp",
    description: "强度渐变：在 sec 秒内从 from 平滑升到（或降到）to，可选再保持 hold 秒，结束后自动停",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "number", description: "起始强度 0-1" },
        to: { type: "number", description: "目标强度 0-1" },
        sec: { type: "number", description: "渐变用时（秒），2-600" },
        hold: { type: "number", description: "到达目标后保持几秒，可选" }
      },
      required: ["from", "to", "sec"]
    }
  },
  {
    name: "toy_preset_save",
    description: "把一段节奏保存成预设，之后可以按名字直接调用。保存在服务器内存里，服务重启会清空",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        steps: {
          type: "array",
          description: "按顺序执行的步骤。每步填 speed（0-1，强度）、pattern（1-8，震动棒花样，配 level 0-1）或 suck（1-10，吮吸模式，配 level 0-1），再填 sec（这一步持续几秒，最少 0.5）。speed 为 0 表示停顿。最多 60 步。",
          items: {
            type: "object",
            properties: {
              speed: { type: "number", description: "强度 0-1；0 = 停顿" },
              pattern: { type: "number", description: "振动花样 1-8（仅震动棒）" },
              suck: { type: "number", description: "吮吸模式 1-10（仅吮吸款，配 level）" },
              level: { type: "number", description: "花样强度 0-1" },
              sec: { type: "number", description: "这一步持续秒数" }
            },
            required: ["sec"]
          }
        },
        loop: { description: "true = 一直循环直到叫停（最多 30 分钟）；数字 = 重复几轮；不填 = 只跑一轮", anyOf: [{ type: "boolean" }, { type: "number" }] }
      },
      required: ["name", "steps"]
    }
  },
  {
    name: "toy_preset_list",
    description: "列出已保存的预设",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "toy_preset_play",
    description: "按名字播放一个已保存的预设",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        loop: { description: "true = 一直循环直到叫停（最多 30 分钟）；数字 = 重复几轮；不填 = 只跑一轮", anyOf: [{ type: "boolean" }, { type: "number" }] }
      },
      required: ["name"]
    }
  },
  {
    name: "toy_preset_delete",
    description: "删除一个预设",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
  }
];

const text = (t) => ({ content: [{ type: "text", text: t }] });

function callTool(name, args) {
  switch (name) {
    case "toy_set_speed":
      cancelSeq();
      currentCmd = {
        type: "speed",
        speed: Math.max(0, Math.min(1, Number(args.speed) || 0)),
        sec: Number(args.sec) || 0
      };
      lastUpdate = Date.now();
      return text(`已设置强度 ${currentCmd.speed}`);
    case "toy_set_pattern":
      cancelSeq();
      currentCmd = {
        type: "pattern",
        pattern: Math.max(1, Math.min(8, Math.round(Number(args.pattern) || 1))),
        level: Math.max(0, Math.min(1, args.level ?? 0.7))
      };
      lastUpdate = Date.now();
      return text(`已设置花样 ${currentCmd.pattern}`);
    case "toy_suck": {
      cancelSeq();
      const mode = clamp(Math.round(Number(args.mode) || 1), 1, 10);
      const level = clamp(Number(args.level ?? 0.6), 0, 1);
      pushCmd({ type: "suck", mode, level, sec: Number(args.sec) || 0 });
      return text(`已设置吮吸模式 ${mode}，强度 ${level}`);
    }
    case "toy_raw": {
      const parts = String(args.hex || "").trim().split(/[\s,]+/);
      const bytes = parts.map((h) => parseInt(h, 16));
      if (bytes.length < 6 || bytes.length > 8 || bytes.some((b) => !(b >= 0 && b <= 255)) ||
          bytes[0] !== 0x55 || ![3, 4, 8, 9].includes(bytes[1])) {
        throw new Error("只允许 55 开头、6-8 字节、指令号 03/04/08/09 的指令");
      }
      cancelSeq();
      const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
      pushCmd({ type: "raw", hex, sec: clamp(Number(args.sec) || 5, 1, 60) });
      return text(`已发送原始指令 ${hex}`);
    }
    case "toy_stop":
      cancelSeq();
      currentCmd = { type: "stop" };
      lastUpdate = Date.now();
      return text("已停止");
    case "toy_status": {
      const ago = lastPoll ? Math.round((Date.now() - lastPoll) / 1000) : null;
      const online = ago !== null && ago < 5;
      const seqInfo = seq ? `\n正在运行序列「${seq.name}」：第 ${seq.round + 1} 轮，第 ${seq.idx}/${seq.steps.length} 步` : "";
      return text((
        online
          ? `中继在线（${ago} 秒前轮询）`
          : ago === null
            ? "中继离线：服务启动后还没有中继来轮询"
            : `中继离线：最后一次轮询在 ${ago} 秒前`
      ) + seqInfo);
    }
    case "toy_sequence": {
      const loop = args.loop ?? false;
      const one = startSeq(args.name || "临时序列", args.steps, loop);
      const loopText = loop === true ? "，循环直到叫停（最多 30 分钟）" : typeof loop === "number" && loop > 1 ? `，重复 ${loop} 轮` : "";
      return text(`已开始序列「${args.name || "临时序列"}」：${args.steps.length} 步，一轮约 ${one.toFixed(1)} 秒${loopText}`);
    }
    case "toy_ramp": {
      const from = clamp(Number(args.from ?? 0), 0, 1);
      const to = clamp(Number(args.to ?? 1), 0, 1);
      const sec = clamp(Number(args.sec) || 10, 2, 600);
      const steps = rampSteps(from, to, sec);
      if (args.hold) steps.push({ speed: to, sec: clamp(Number(args.hold), MIN_STEP_SEC, 600) });
      startSeq(`渐变 ${from}→${to}`, steps, false);
      return text(`已开始渐变：${sec} 秒内从 ${from} 到 ${to}` + (args.hold ? `，然后保持 ${args.hold} 秒` : "") + "，结束后自动停");
    }
    case "toy_preset_save": {
      if (!args.name) throw new Error("需要 name");
      if (!Array.isArray(args.steps) || !args.steps.length) throw new Error("steps 不能为空");
      presets.set(args.name, { steps: args.steps.slice(0, MAX_STEPS), loop: args.loop ?? false });
      return text(`已保存预设「${args.name}」（${args.steps.length} 步）。注意：服务器重启后预设会清空`);
    }
    case "toy_preset_list": {
      if (!presets.size) return text("还没有保存的预设");
      return text([...presets].map(([n, p]) => `- ${n}：${p.steps.length} 步${p.loop ? "，循环" : ""}\n  ${JSON.stringify(p.steps)}`).join("\n"));
    }
    case "toy_preset_play": {
      const p = presets.get(args.name);
      if (!p) return text(`没有叫「${args.name}」的预设。先用 toy_preset_list 看看有哪些`);
      const loop = args.loop ?? p.loop;
      const one = startSeq(args.name, p.steps, loop);
      return text(`已开始预设「${args.name}」，一轮约 ${one.toFixed(1)} 秒`);
    }
    case "toy_preset_delete":
      return text(presets.delete(args.name) ? `已删除预设「${args.name}」` : `没有叫「${args.name}」的预设`);
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
        serverInfo: { name: "svakom-bridge", version: "1.4.0" }
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
