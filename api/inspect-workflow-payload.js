import { timingSafeEqual } from "node:crypto";

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) return false;

  const received = Buffer.from(String(receivedSecret));
  const expected = Buffer.from(String(expectedSecret));

  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysOf(value) {
  return isObject(value) ? Object.keys(value).slice(0, 50) : [];
}

function describe(value) {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
    };
  }

  if (isObject(value)) {
    return {
      type: "object",
      keys: Object.keys(value).slice(0, 30),
    };
  }

  if (typeof value === "string") {
    return {
      type: "string",
      length: value.length,
      preview: value.slice(0, 150),
    };
  }

  return {
    type: typeof value,
    value,
  };
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

  const body = isObject(request.body) ? request.body : {};

  return response.status(200).json({
    ok: true,

    topLevelKeys: keysOf(body),

    event: describe(body.event),
    contact: describe(body.contact),
    variables: describe(body.variables),
    message: describe(body.message),

    conversationId: describe(body.conversationId),
    contactId: describe(body.contactId),
    messageText: describe(body.messageText),
    voiceTranscript: describe(body.voiceTranscript),

    nestedCandidates: {
      eventMessage: describe(body.event?.message),
      eventBody: describe(body.event?.body),
      eventText: describe(body.event?.text),

      contactId: describe(body.contact?.id),
      contactInternalId: describe(body.contact?._id),
      contactPhone: describe(body.contact?.phone),

      variableMessage: describe(body.variables?.message),
      variableMessageBody: describe(body.variables?.message?.body),
      variableConversationId: describe(
        body.variables?.conversationId,
      ),
      variableContactId: describe(body.variables?.contactId),
      variableVoiceInput: describe(body.variables?.voiceInput),
      variableAppointmentResult: describe(
        body.variables?.appointmentResult,
      ),
    },
  });
}
