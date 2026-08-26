import { timingSafeEqual } from "node:crypto";

const ZERNIO_API_BASE_URL = "https://zernio.com/api/v1";

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) return false;
  const received = Buffer.from(receivedSecret);
  const expected = Buffer.from(expectedSecret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function normalizePhone(value) {
  return String(value ?? "").replace(/\D/g, "");
}

async function zernioFetch(path, options = {}) {
  return fetch(`${ZERNIO_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

async function resolveContactId(identifier) {
  const directResponse = await zernioFetch(
    `/contacts/${encodeURIComponent(identifier)}`,
  );

  if (directResponse.ok) {
    const directData = await directResponse.json();
    return directData?.contact?.id ?? identifier;
  }

  const targetPhone = normalizePhone(identifier);
  if (!targetPhone) return null;

  const listResponse = await zernioFetch("/contacts?platform=whatsapp&limit=200");
  if (!listResponse.ok) return null;

  const listData = await listResponse.json();
  const contact = listData?.contacts?.find((candidate) => {
    const platformIdentifier = normalizePhone(candidate.platformIdentifier);
    const displayIdentifier = normalizePhone(candidate.displayIdentifier);
    return platformIdentifier === targetPhone || displayIdentifier === targetPhone;
  });

  return contact?.id ?? null;
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (
    !secretsMatch(
      request.body?.webhookSecret,
      process.env.INTERNAL_WEBHOOK_SECRET,
    )
  ) {
    return response.status(401).json({ ok: false, error: "Invalid secret" });
  }

  const identifier = request.body?.identifier;
  if (typeof identifier !== "string" || identifier.length < 1 || identifier.length > 200) {
    return response.status(400).json({ ok: false, error: "Enter a valid contact ID or WhatsApp number" });
  }

  if (!process.env.ZERNIO_API_KEY) {
    return response.status(500).json({ ok: false, error: "Server configuration error" });
  }

  try {
    const contactId = await resolveContactId(identifier.trim());
    if (!contactId) {
      return response.status(404).json({ ok: false, error: "Contact not found" });
    }

    const updateResponse = await zernioFetch(
      `/contacts/${encodeURIComponent(contactId)}/fields/ai_status`,
      {
        method: "PUT",
        body: JSON.stringify({ value: "active" }),
      },
    );

    if (!updateResponse.ok) {
      console.error("Zernio AI status update failed", { status: updateResponse.status });
      return response.status(502).json({ ok: false, error: "Could not update AI status" });
    }

    return response.status(200).json({ ok: true, status: "active" });
  } catch (error) {
    console.error("Unexpected AI reactivation error", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return response.status(502).json({ ok: false, error: "Could not reactivate the assistant" });
  }
}
