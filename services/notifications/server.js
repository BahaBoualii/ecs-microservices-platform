const crypto = require("crypto");
const express = require("express");
const AWSXRay = require("aws-xray-sdk");

const app = express();
app.use(express.json());
app.use(AWSXRay.express.openSegment("notifications-service"));

const PORT = process.env.PORT || 3000;

const MAX_HISTORY = 50;
let history = [];

app.get("/health", (req, res) => res.json({ status: "ok", service: "notifications" }));

app.post("/notify", (req, res) => {
  const { message, userId } = req.body || {};
  if (!message) return res.status(400).json({ error: "`message` is required" });

  const entry = { id: crypto.randomUUID(), message, userId, receivedAt: new Date().toISOString() };
  history.unshift(entry);
  history = history.slice(0, MAX_HISTORY);

  console.log(`[notification] ${entry.receivedAt} — ${message}`);
  res.status(202).json({ accepted: true, id: entry.id });
});

app.get("/notifications", (req, res) => res.json({ notifications: history }));

app.use(AWSXRay.express.closeSegment());

const server = app.listen(PORT, () => console.log(`notifications-service listening on ${PORT}`));

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
});
