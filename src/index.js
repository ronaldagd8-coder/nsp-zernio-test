import express from "express";

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.get("/", (_request, response) => {
  response.json({
    ok: true,
    service: "nsp-zernio-test",
    status: "ready",
  });
});

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.use((_request, response) => {
  response.status(404).json({ ok: false, error: "Not found" });
});

app.use((error, _request, response, _next) => {
  console.error("Unhandled request error", error);
  response.status(500).json({ ok: false, error: "Internal server error" });
});

export default app;
