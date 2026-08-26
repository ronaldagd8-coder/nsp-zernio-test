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

function findTextCandidates(value, depth = 0, results = []) {
  if (
    value === null ||
    value === undefined ||
    depth > 7 ||
    results.length >= 5
  ) {
    return results;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) {
      findTextCandidates(item, depth + 1, results);
    }

    return results;
  }

  if (typeof value !== "object") {
    return results;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (
      /^(message|messageText|text|content|transcript|voiceTranscript)$/i.test(
        key,
      ) &&
      typeof nestedValue === "string" &&
      nestedValue.trim()
    ) {
      results.push(nestedValue.trim().slice(0, 160));
    }

    if (
      nestedValue &&
      typeof nestedValue === "object"
    ) {
      findTextCandidates(
        nestedValue,
        depth + 1,
        results,
      );
    }

    if (results.length >= 5) break;
  }

  return results;
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

  const body =
    request.body &&
    typeof request.body === "object" &&
    !Array.isArray(request.body)
      ? request.body
      : {};

  const conversationId =
    body.conversationId ??
    body.event?.conversationId ??
    body.variables?.conversationId ??
    null;

  const contactId =
    body.contactId ??
    body.contact?.id ??
    body.contact?._id ??
    body.variables?.contactId ??
    body.variables?.contact?.id ??
    null;

  const textCandidates = findTextCandidates(body);

  return response.status(200).json({
    ok: true,
    message: textCandidates[0] ?? null,
    contactId,
    conversationId,
    candidates: textCandidates,
  });
}
