import { timingSafeEqual } from "node:crypto";

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) return false;

  const received = Buffer.from(receivedSecret);
  const expected = Buffer.from(expectedSecret);

  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
}

function safeUrlDetails(value) {
  try {
    const parsedUrl = new URL(value);

    return {
      origin: parsedUrl.origin,
      pathname: parsedUrl.pathname,
    };
  } catch {
    return {
      valueType: "string",
      length: String(value).length,
    };
  }
}

function inspectPayload(value, path = "body", depth = 0, findings = []) {
  if (depth > 10 || findings.length >= 100) {
    return findings;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      inspectPayload(
        item,
        `${path}[${index}]`,
        depth + 1,
        findings,
      );
    });

    return findings;
  }

  if (!value || typeof value !== "object") {
    return findings;
  }

  for (const [key, childValue] of Object.entries(value)) {
    if (findings.length >= 100) break;

    const childPath = `${path}.${key}`;
    const normalizedKey = key.toLowerCase();

    const isRelevantKey =
      normalizedKey.includes("attachment") ||
      normalizedKey.includes("audio") ||
      normalizedKey.includes("media") ||
      normalizedKey.includes("mime") ||
      normalizedKey === "accountid" ||
      normalizedKey === "messageid";

    if (isRelevantKey) {
      if (Array.isArray(childValue)) {
        findings.push({
          path: childPath,
          valueType: "array",
          itemCount: childValue.length,
        });
      } else if (childValue && typeof childValue === "object") {
        findings.push({
          path: childPath,
          valueType: "object",
          keys: Object.keys(childValue).slice(0, 30),
        });
      } else if (typeof childValue === "string") {
        findings.push({
          path: childPath,
          valueType: "string",
          value: childValue.slice(0, 300),
        });
      } else {
        findings.push({
          path: childPath,
          valueType: typeof childValue,
        });
      }
    }

    const pathSuggestsMedia =
      childPath.toLowerCase().includes("attachment") ||
      childPath.toLowerCase().includes("audio") ||
      childPath.toLowerCase().includes("media");

    if (
      pathSuggestsMedia &&
      ["id", "type", "mimetype", "filename"].includes(normalizedKey) &&
      typeof childValue === "string"
    ) {
      findings.push({
        path: childPath,
        valueType: "string",
        value: childValue.slice(0, 300),
      });
    }

    if (
      pathSuggestsMedia &&
      normalizedKey === "url" &&
      typeof childValue === "string"
    ) {
      findings.push({
        path: childPath,
        valueType: "url",
        ...safeUrlDetails(childValue),
      });
    }

    if (childValue && typeof childValue === "object") {
      inspectPayload(
        childValue,
        childPath,
        depth + 1,
        findings,
      );
    }
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
    request.body && typeof request.body === "object"
      ? request.body
      : {};

  const findings = inspectPayload(body);

      const compactFindings = Array.isArray(findings)
    ? findings
        .filter((item) => {
          const path = String(item?.path ?? "").toLowerCase();

          return (
            path.includes("attachment") ||
            path.includes("audio") ||
            path.includes("media") ||
            path.includes("accountid")
          );
        })
        .slice(0, 20)
        .map((item) => ({
          path: String(item?.path ?? "").slice(0, 250),
          type: String(item?.valueType ?? ""),
          value:
            typeof item?.value === "string"
              ? item.value.slice(0, 250)
              : undefined,
          pathname:
            typeof item?.pathname === "string"
              ? item.pathname.slice(0, 250)
              : undefined,
          keys: Array.isArray(item?.keys)
            ? item.keys.slice(0, 20)
            : undefined,
          count:
            typeof item?.itemCount === "number"
              ? item.itemCount
              : undefined,
        }))
    : [];

    return response.status(200).json({
    ok: true,
    findings: compactFindings,
  });
}
