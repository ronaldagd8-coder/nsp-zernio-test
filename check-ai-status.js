import { timingSafeEqual } from "node:crypto";

const ZERNIO_API_BASE_URL = "https://zernio.com/api/v1";

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) return false;

  const received = Buffer.from(receivedSecret);
  const expected = Buffer.from(expectedSecret);

  return received.length === expected.length && timingSafeEqual(received, expected);
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const receivedSecret =
    request.headers["x-webhook-secret"] ?? request.body?.webhookSecret;

  if (!secretsMatch(receivedSecret, process.env.INTERNAL_WEBHOOK_SECRET)) {
    return response.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const contactId =
    request.body?.contactId ??
    request.body?.contact?.id ??
    request.body?.sender?.contactId ??
    request.body?.message?.sender?.contactId ??
    request.body?.variables?.message?.sender?.contactId;

  if (typeof contactId !== "string" || contactId.length < 1 || contactId.length > 200) {
    return response.status(400).json({ ok: false, error: "A valid contactId is required" });
  }

  if (!process.env.ZERNIO_API_KEY) {
    return response.status(500).json({ ok: false, error: "Server configuration error" });
  }

  try {
    const zernioResponse = await fetch(
      `${ZERNIO_API_BASE_URL}/contacts/${encodeURIComponent(contactId)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
          Accept: "application/json",
        },
      },
    );

    if (!zernioResponse.ok) {
      console.error("Zernio contact lookup failed", {
        status: zernioResponse.status,
      });
      return response.status(502).json({ ok: false, error: "Contact lookup failed" });
    }

    const data = await zernioResponse.json();
    const aiStatus = data?.contact?.customFields?.ai_status ?? null;

    return response.status(200).json({
      ok: true,
      paused: aiStatus === "human",
      status: aiStatus,
    });
  } catch (error) {
    console.error("Unexpected contact lookup error", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return response.status(502).json({ ok: false, error: "Contact lookup failed" });
  }
}
