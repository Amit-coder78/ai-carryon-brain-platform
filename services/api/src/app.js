import express from "express";
import { randomUUID } from "node:crypto";
import { registryRouter, errorHandler } from "./registry.js";
import { signalsRouter } from "./signals.js";
import { lifecycleRouter } from "./lifecycle.js";
import { NO_SIGNING } from "./signing.js";

export function createApp({ checkDb, pool, signing = NO_SIGNING } = {}) {
  const app = express();
  app.use((req, res, next) => {
    req.correlationId = req.get("x-correlation-id") || randomUUID();
    res.set("x-correlation-id", req.correlationId);
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/v1/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/v1/ready", async (req, res) => {
    try {
      if (checkDb) await checkDb();
      res.json({ status: "ready" });
    } catch (e) {
      res.status(503).json({ code: "not_ready", message: "database unavailable", correlation_id: req.correlationId });
    }
  });
  if (pool) {
    app.use("/v1", registryRouter(pool));
    app.use("/v1", lifecycleRouter(pool, signing));
    app.use("/v1", signalsRouter(pool));
  }
  app.use((req, res) => res.status(404).json({ code: "not_found", message: "no such route", correlation_id: req.correlationId }));
  app.use(errorHandler);
  return app;
}
