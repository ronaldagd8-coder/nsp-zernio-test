import { createSign } from "node:crypto";

const GOOGLE_TOKEN_URL =
  "https://oauth2.googleapis.com/token";

const GOOGLE_CALENDAR_API =
  "https://www.googleapis.com/calendar/v3";

const GOOGLE_CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar";

export const config = {
  maxDuration: 30,
};

function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function loadServiceAccount() {
  const encodedCredentials =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;

  if (!encodedCredentials) {
    throw new Error(
      "Google service account credentials are missing",
    );
  }

  const decodedCredentials = Buffer.from(
    encodedCredentials,
    "base64",
  ).toString("utf8");

  const credentials =
    JSON.parse(decodedCredentials);

  if (
    !credentials?.client_email ||
    !credentials?.private_key
  ) {
    throw new Error(
      "Google service account credentials are invalid",
    );
  }

  return credentials;
}

async function getGoogleAccessToken() {
  const credentials = loadServiceAccount();
  const issuedAt = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iss: credentials.client_email,
    scope: GOOGLE_CALENDAR_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };

  const unsignedToken =
    `${encodeBase64Url(JSON.stringify(header))}.` +
    `${encodeBase64Url(JSON.stringify(payload))}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();

  const signature = signer.sign(
    credentials.private_key,
  );

  const assertion =
    `${unsignedToken}.` +
    `${encodeBase64Url(signature)}`;

  const tokenResponse = await fetch(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:
          "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    },
  );

  const tokenData = await tokenResponse.json();

  if (
    !tokenResponse.ok ||
    !tokenData?.access_token
  ) {
    throw new Error(
      tokenData?.error_description ??
        "Google authentication failed",
    );
  }

  return tokenData.access_token;
}

export default async function handler(
  request,
  response,
) {
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");

    return response.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  if (!process.env.GOOGLE_CALENDAR_ID) {
    return response.status(500).json({
      ok: false,
      error: "Google Calendar ID is missing",
    });
  }

  try {
    const accessToken =
      await getGoogleAccessToken();

    const calendarResponse = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/` +
        `${encodeURIComponent(
          process.env.GOOGLE_CALENDAR_ID,
        )}`,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
    );

    const calendarData =
      await calendarResponse.json();

    if (!calendarResponse.ok) {
      console.error(
        "Google Calendar lookup failed",
        {
          status: calendarResponse.status,
        },
      );

      return response.status(502).json({
        ok: false,
        error:
          calendarData?.error?.message ??
          "Google Calendar lookup failed",
      });
    }

    return response.status(200).json({
      ok: true,
      service: "google-calendar",
      calendar:
        calendarData?.summary ?? null,
      timeZone:
        calendarData?.timeZone ?? null,
      status: "ready",
    });
  } catch (error) {
    console.error(
      "Google Calendar health check failed",
      {
        message:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
    );

    return response.status(500).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Google Calendar health check failed",
    });
  }
}
