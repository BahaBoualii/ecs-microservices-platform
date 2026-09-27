const AWSXRay = require("aws-xray-sdk");

AWSXRay.captureHTTPsGlobal(require("http"));
AWSXRay.capturePromise();

const crypto = require("crypto");
const express = require("express");
const Redis = require("ioredis");
const fetch = require("node-fetch");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const PORT = process.env.PORT || 3000;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || "http://auth.internal.saa-microservices.local:3000";
const NOTIFICATIONS_SERVICE_URL =
  process.env.NOTIFICATIONS_SERVICE_URL || "http://notifications.internal.saa-microservices.local:3000";
const ORDERS_TABLE = process.env.ORDERS_TABLE || "saa-microservices-orders";
const DOWNSTREAM_TIMEOUT_MS = 2000;
const ddbConfig = process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {};
const ddb = DynamoDBDocumentClient.from(AWSXRay.captureAWSv3Client(new DynamoDBClient(ddbConfig)));

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: DOWNSTREAM_TIMEOUT_MS,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});
redis.on("error", (err) => console.warn("Redis error:", err.message));
redis.connect().catch((err) => console.error("Redis connection failed:", err.message));

const ORDERS_CACHE_TTL_SECONDS = 30;
const cacheKey = (userId) => `orders:${userId}`;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Returns the token's claims, or null if the token is missing/invalid.
// Throws if Auth itself is unreachable, so callers can answer 503 instead of 401.
async function verifyToken(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const res = await fetchWithTimeout(`${AUTH_SERVICE_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (res.status === 400 || res.status === 401) return null;
  if (!res.ok) throw new Error(`Auth /verify returned ${res.status}`);
  const body = await res.json();
  return body.valid ? body.claims : null;
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const requireAuth = asyncHandler(async (req, res, next) => {
  let claims;
  try {
    claims = await verifyToken(req.headers.authorization);
  } catch (err) {
    console.error("Token verification unavailable:", err.message);
    return res.status(503).json({ error: "Authentication service unavailable" });
  }
  if (!claims) return res.status(401).json({ error: "Unauthorized" });
  req.user = claims;
  next();
});

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(AWSXRay.express.openSegment("orders-service"));

app.get("/health", (req, res) => res.json({ status: "ok", service: "orders" }));

const orders = express.Router();
orders.use(requireAuth);

orders.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user.sub;

    try {
      const cached = await redis.get(cacheKey(userId));
      if (cached) return res.json({ orders: JSON.parse(cached), source: "cache" });
    } catch (err) {
      console.warn("Redis read failed, falling back to DynamoDB:", err.message);
    }

    const result = await ddb.send(
      new QueryCommand({
        TableName: ORDERS_TABLE,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
      })
    );
    const items = (result.Items || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    await redis.set(cacheKey(userId), JSON.stringify(items), "EX", ORDERS_CACHE_TTL_SECONDS).catch(() => {});
    res.json({ orders: items, source: "origin" });
  })
);

orders.post(
  "/",
  asyncHandler(async (req, res) => {
    const { item, quantity = 1 } = req.body || {};
    if (typeof item !== "string" || !item.trim() || item.length > 200) {
      return res.status(400).json({ error: "`item` must be a non-empty string of at most 200 characters" });
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
      return res.status(400).json({ error: "`quantity` must be an integer between 1 and 1000" });
    }

    const order = {
      userId: req.user.sub,
      orderId: crypto.randomUUID(),
      item: item.trim(),
      quantity,
      createdAt: new Date().toISOString(),
    };
    await ddb.send(new PutCommand({ TableName: ORDERS_TABLE, Item: order }));
    await redis.del(cacheKey(order.userId)).catch(() => {});

    fetchWithTimeout(`${NOTIFICATIONS_SERVICE_URL}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Order ${order.orderId} placed for ${order.quantity}x ${order.item}`,
        userId: order.userId,
      }),
    }).catch((err) => console.warn("Notification dispatch failed:", err.message));

    res.status(201).json(order);
  })
);

app.use("/api/orders", orders);

app.use(AWSXRay.express.closeSegment());

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(PORT, () => console.log(`orders-service listening on ${PORT}`));

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down");
  server.close(() => {
    redis.quit().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000).unref();
});
