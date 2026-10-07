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
    name: "toy_stop",
    description: "立即停止",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "toy_status",
    description: "查询中继是否在线",
    inputSchema: { type: "object", properties: {} }
  }
];

const text = (t) => ({ content: [{ type: "text", text: t }] });

function callTool(name, args) {
  switch (name) {
    case "toy_set_speed":
      currentCmd = {
        type: "speed",
        speed: Math.max(0, Math.min(1, Number(args.speed) || 0)),
        sec: Number(args.sec) || 0
      };
      lastUpdate = Date.now();
      return text(`已设置强度 ${currentCmd.speed}`);
    case "toy_set_pattern":
      currentCmd = {
        type: "pattern",
        pattern: Math.max(1, Math.min(8, Math.round(Number(args.pattern) || 1))),
        level: Math.max(0, Math.min(1, args.level ?? 0.7))
      };
      lastUpdate = Date.now();
      return text(`已设置花样 ${currentCmd.pattern}`);
    case "toy_stop":
      currentCmd = { type: "stop" };
      lastUpdate = Date.now();
      return text("已停止");
    case "toy_status": {
      const ago = lastPoll ? Math.round((Date.now() - lastPoll) / 1000) : null;
      const online = ago !== null && ago < 5;
      return text(
        online
          ? `中继在线（${ago} 秒前轮询）`
          : ago === null
            ? "中继离线：服务启动后还没有中继来轮询"
            : `中继离线：最后一次轮询在 ${ago} 秒前`
      );
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
        serverInfo: { name: "svakom-bridge", version: "1.1.0" }
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const result = callTool(params?.name, params?.arguments || {});
      return result ? ok(result) : err(-32602, `unknown tool: ${params?.name}`);
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
