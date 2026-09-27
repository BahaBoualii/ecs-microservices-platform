const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const AWSXRay = require("aws-xray-sdk");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("JWT_SECRET is not set; refusing to start");
  process.exit(1);
}

// Demo user store. In a real system this would be a database (or Cognito) with hashed passwords.
const USERS = [{ username: "demo", password: "demo1234", userId: "u-1001" }];

function safeEqual(a, b) {
  const hash = (v) => crypto.createHash("sha256").update(String(v)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

const app = express();
app.use(express.json());
app.use(AWSXRay.express.openSegment("auth-service"));

app.get("/health", (req, res) => res.json({ status: "ok", service: "auth" }));

const publicRoutes = express.Router();

publicRoutes.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = USERS.find((u) => u.username === username);
  if (!user || !safeEqual(password, user.password)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ sub: user.userId, username: user.username }, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "1h",
  });
  res.json({ token });
});

app.use("/api/auth", publicRoutes);

// Internal route: called by other services (e.g. Orders) over Cloud Map DNS.
// It is deliberately outside /api/auth, so the ALB never routes to it.
app.post("/verify", (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "token is required" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    res.json({ valid: true, claims: decoded });
  } catch (err) {
    res.status(401).json({ valid: false, error: "Invalid or expired token" });
  }
});

app.use(AWSXRay.express.closeSegment());

const server = app.listen(PORT, () => console.log(`auth-service listening on ${PORT}`));

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
});
