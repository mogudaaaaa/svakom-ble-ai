import express from "express";

const app = express();
app.use(express.json());

const SECRET = process.env.BRIDGE_SECRET || "change-me";
const PORT = process.env.PORT || 3000;

// 简单内存队列，存最新一条指令
let currentCmd = null;
let lastUpdate = 0;

// 校验 secret
function checkSecret(req, res, next) {
  const secret = req.query.secret || req.headers["x-bridge-secret"];
  if (secret !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// 安卓网页轮询用：获取下一条指令
app.get("/toy-next", checkSecret, (req, res) => {
  if (currentCmd && Date.now() - lastUpdate < 15000) {
    // 15秒内有效
    const cmd = currentCmd;
    currentCmd = null; // 取走后清空，避免重复执行
    return res.json(cmd);
  }
  res.json({ type: "hello" });
});

// 简单设置指令接口（方便测试）
app.post("/toy", checkSecret, (req, res) => {
  currentCmd = req.body;
  lastUpdate = Date.now();
  res.json({ ok: true });
});

// Claude MCP 用的简易接口
app.post("/mcp", checkSecret, (req, res) => {
  // 这里只做最基础的工具调用转发，够用
  const { method, params } = req.body || {};

  if (method === "tools/list") {
    return res.json({
      tools: [
        {
          name: "toy_set_speed",
          description: "设置分欣强度 (0.0-1.0)",
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
          description: "查询中继状态",
          inputSchema: { type: "object", properties: {} }
        }
      ]
    });
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === "toy_set_speed") {
      currentCmd = {
        type: "speed",
        speed: Math.max(0, Math.min(1, args.speed || 0)),
        sec: args.sec || 0
      };
      lastUpdate = Date.now();
      return res.json({ content: [{ type: "text", text: `已设置强度 ${currentCmd.speed}` }] });
    }

    if (name === "toy_set_pattern") {
      currentCmd = {
        type: "pattern",
        pattern: args.pattern || 1,
        level: args.level || 0.7
      };
      lastUpdate = Date.now();
      return res.json({ content: [{ type: "text", text: `已设置花样 ${currentCmd.pattern}` }] });
    }

    if (name === "toy_stop") {
      currentCmd = { type: "stop" };
      lastUpdate = Date.now();
      return res.json({ content: [{ type: "text", text: "已停止" }] });
    }

    if (name === "toy_status") {
      return res.json({
        content: [{
          type: "text",
          text: currentCmd
            ? `中继在线，最近指令：${JSON.stringify(currentCmd)}`
            : "中继在线，暂无指令"
        }]
      });
    }
  }

  res.json({ error: "unknown method" });
});

// 兼容 Claude 用 GET 方式探测
app.get("/mcp", checkSecret, (req, res) => {
  res.json({ status: "ok", message: "svakom bridge ready" });
});

app.get("/", (req, res) => {
  res.send("SVAKOM Bridge is running");
});

app.listen(PORT, () => {
  console.log(`Bridge running on port ${PORT}`);
});
