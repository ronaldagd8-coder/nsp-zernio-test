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
  return value !== null && typeof value === "object";
}

function isRelevantPath(path) {
  return /(message|text|body|content|contact|conversation|transcript|voice|audio|phone|identifier)/i.test(
    path,
  );
}

function isSensitivePath(path) {
  return /(secret|token|authorization|password|api.?key)/i.test(path);
}

function safeValue(value) {
  if (typeof value === "string") {
    return value.slice(0, 180);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  return null;
}

function findRelevantValues(
  value,
  currentPath = "body",
  depth = 0,
  findings = [],
) {
  if (depth > 6 || findings.length >= 20) {
    return findings;
  }

  if (
    value === null ||
    value === undefined ||
    typeof value !== "object"
  ) {
    if (
      isRelevantPath(currentPath) &&
      !isSensitivePath(currentPath)
    ) {
      const cleanedValue = safeValue(value);

      if (cleanedValue !== null && cleanedValue !== "") {
        findings.push({
          path: currentPath,
          value: cleanedValue,
        });
      }
    }

    return findings;
  }

  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((item, index) => {
      findRelevantValues(
        item,
        `${currentPath}[${index}]`,
        depth + 1,
        findings,
      );
    });

    return findings;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nextPath = `${currentPath}.${key}`;

    if (isSensitivePath(nextPath)) {
      continue;
    }

    findRelevantValues(
      nestedValue,
      nextPath,
      depth + 1,
      findings,
    );

    if (findings.length >= 20) break;
  }

  return findings;
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
    isObject(request.body) && !Array.isArray(request.body)
      ? request.body
      : {};

  const findings = findRelevantValues(body);

  return response.status(200).json({
    ok: true,
    findings,
    variableKeys:
      body.variables && typeof body.variables === "object"
        ? Object.keys(body.variables).slice(0, 30)
        : [],
    eventKeys:
      body.event && typeof body.event === "object"
        ? Object.keys(body.event).slice(0, 30)
        : [],
  });
}
