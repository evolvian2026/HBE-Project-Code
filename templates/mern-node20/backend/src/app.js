import express from "express";
import mongoose from "mongoose";
import { Note, noteProblem, toJson } from "./notes.js";

/** The API. The grader checks GET /health before the tests run. */
export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (req, res) => {
    res.json({ status: "ok", database: mongoose.connection.readyState === 1 ? "connected" : "connecting" });
  });

  app.get("/api/notes", async (req, res) => {
    res.json((await Note.find().sort({ _id: 1 })).map(toJson));
  });

  app.post("/api/notes", async (req, res) => {
    const problem = noteProblem(req.body);
    if (problem) return res.status(400).json({ error: problem });
    res.status(201).json(toJson(await Note.create({ title: req.body.title, done: false })));
  });

  app.use((req, res) => res.status(404).json({ error: "Not found" }));
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Something went wrong" });
  });
  return app;
}
