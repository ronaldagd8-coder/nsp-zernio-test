import { timingSafeEqual } from "node:crypto";

const ZERNIO_API_BASE_URL = "https://zernio.com/api/v1";

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) return false;

  const received = Buffer.from(receivedSecret);
  const expected = Buffer.from(expectedSecret);

  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
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
  if (!identifier) return null;

  const directResponse = await zernioFetch(
    `/contacts/${encodeURIComponent(identifier)}`,
  );

  if (directResponse.ok) {
    const directData = await directResponse.json();
    return directData?.contact?.id ?? identifier;
  }

  const targetPhone = normalizePhone(identifier);
  if (!targetPhone) return null;

  const listResponse = await zernioFetch(
    "/contacts?platform=whatsapp&limit=200",
  );

  if (!listResponse.ok) return null;

  const listData = await listResponse.json();

  const contact = listData?.contacts?.find((candidate) => {
    const candidateNumbers = [
      candidate?.phone,
      candidate?.platformIdentifier,
      candidate?.displayIdentifier,
    ]
      .map(normalizePhone)
      .filter(Boolean);

    return candidateNumbers.includes(targetPhone);
  });

  return contact?.id ?? null;
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const receivedSecret =
    request.headers["x-webhook-secret"] ??
    request.body?.webhookSecret ??
    request.query?.secret;

  if (
    !secretsMatch(
      receivedSecret,
      process.env.INTERNAL_WEBHOOK_SECRET,
    )
  ) {
    return response.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  if (!process.env.ZERNIO_API_KEY) {
    return response.status(500).json({
      ok: false,
      error: "Server configuration error",
    });
  }

  const directContactId =
    request.body?.contactId ??
    request.body?.contact?.id ??
    request.body?.contact?._id ??
    request.body?.contact?.contactId;

  const phoneIdentifier =
    request.body?.contact?.phone ??
    request.body?.contact?.platformIdentifier ??
    request.body?.contact?.displayIdentifier ??
    request.body?.phone;

  const identifier =
    typeof directContactId === "string" && directContactId.trim()
      ? directContactId.trim()
      : String(phoneIdentifier ?? "").trim();

  if (!identifier || identifier.length > 200) {
    return response.status(400).json({
      ok: false,
      error: "No valid contact ID or phone number was received",
    });
  }

  try {
    const contactId = await resolveContactId(identifier);

    if (!contactId) {
      return response.status(404).json({
        ok: false,
        error: "Contact not found",
      });
    }

    const pausedAt = new Date().toISOString();

    const [statusResponse, timestampResponse] = await Promise.all([
      zernioFetch(
        `/contacts/${encodeURIComponent(contactId)}/fields/ai_status`,
        {
          method: "PUT",
          body: JSON.stringify({ value: "human" }),
        },
      ),
      zernioFetch(
        `/contacts/${encodeURIComponent(contactId)}/fields/ai_paused_at`,
        {
          method: "PUT",
          body: JSON.stringify({ value: pausedAt }),
        },
      ),
    ]);

    if (!statusResponse.ok || !timestampResponse.ok) {
      console.error("Zernio AI pause update failed", {
        statusUpdate: statusResponse.status,
        timestampUpdate: timestampResponse.status,
      });

      return response.status(502).json({
        ok: false,
        error: "Could not pause AI",
      });
    }

    return response.status(200).json({
      ok: true,
      status: "human",
      pausedAt,
    });
  } catch (error) {
    console.error("Unexpected AI pause error", {
      message:
        error instanceof Error
          ? error.message
          : "Unknown error",
    });

    return response.status(502).json({
      ok: false,
      error: "Could not pause AI",
    });
  }
}
