import { timingSafeEqual } from "node:crypto";

const ZERNIO_API_BASE_URL = "https://zernio.com/api/v1";
const AI_PAUSE_DURATION_MS = 1 * 60 * 1000;

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
    request.body?.contact?.contactId ??
    request.body?.context?.contactId ??
    request.body?.context?.contact?.id ??
    request.body?.sender?.contactId ??
    request.body?.message?.sender?.contactId ??
    request.body?.variables?.contactId ??
    request.body?.variables?.contact?.id ??
    request.body?.variables?.contact?._id ??
    request.body?.vars?.contactId ??
    request.body?.vars?.contact?.id ??
    request.body?.vars?.contact?._id;

  const phoneIdentifier =
    request.body?.contact?.phone ??
    request.body?.contact?.platformIdentifier ??
    request.body?.contact?.displayIdentifier ??
    request.body?.phone ??
    request.body?.sender?.phone ??
    request.body?.message?.sender?.phone ??
    request.body?.variables?.contact?.phone ??
    request.body?.vars?.contact?.phone;

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

    const contactResponse = await zernioFetch(
      `/contacts/${encodeURIComponent(contactId)}`,
    );

    if (!contactResponse.ok) {
      console.error("Zernio contact lookup failed", {
        status: contactResponse.status,
      });

      return response.status(502).json({
        ok: false,
        error: "Contact lookup failed",
      });
    }

    const data = await contactResponse.json();
    const contact = data?.contact ?? data;

    const customFields =
      contact?.customFields ??
      contact?.metadata?.customFields ??
      {};

    const aiStatus = customFields?.ai_status ?? null;
    const pausedAt = customFields?.ai_paused_at ?? null;

    if (aiStatus === "human") {
      const pausedAtMilliseconds = Date.parse(pausedAt);
      const pausedAtIsValid = Number.isFinite(pausedAtMilliseconds);

      if (pausedAtIsValid) {
        const elapsedMilliseconds =
          Date.now() - pausedAtMilliseconds;

        if (elapsedMilliseconds >= AI_PAUSE_DURATION_MS) {
          const activationResponse = await zernioFetch(
            `/contacts/${encodeURIComponent(contactId)}/fields/ai_status`,
            {
              method: "PUT",
              body: JSON.stringify({ value: "active" }),
            },
          );

          if (!activationResponse.ok) {
            console.error("Automatic AI reactivation failed", {
              status: activationResponse.status,
            });

            return response.status(502).json({
              ok: false,
              error: "Automatic reactivation failed",
            });
          }

          return response.status(200).json({
            ok: true,
            paused: false,
            status: "active",
            autoReactivated: true,
            contactId,
          });
        }

        const remainingMilliseconds =
          AI_PAUSE_DURATION_MS - elapsedMilliseconds;

        return response.status(200).json({
          ok: true,
          paused: true,
          status: "human",
          autoReactivated: false,
          remainingMinutes: Math.ceil(
            remainingMilliseconds / 60000,
          ),
          contactId,
        });
      }

      return response.status(200).json({
        ok: true,
        paused: true,
        status: "human",
        autoReactivated: false,
        reason: "Missing or invalid pause timestamp",
        contactId,
      });
    }

    return response.status(200).json({
      ok: true,
      paused: false,
      status: aiStatus,
      autoReactivated: false,
      contactId,
    });
  } catch (error) {
    console.error("Unexpected contact lookup error", {
      message:
        error instanceof Error
          ? error.message
          : "Unknown error",
    });

    return response.status(502).json({
      ok: false,
      error: "Contact lookup failed",
    });
  }
}
