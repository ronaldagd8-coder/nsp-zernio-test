const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>NSP - Reactivate Luna / Sky</title>
    <style>
      :root { color-scheme: dark; font-family: Arial, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #10131a; color: #f6f7fb; }
      main { width: min(92vw, 480px); padding: 28px; border: 1px solid #2d3442; border-radius: 16px; background: #191e28; }
      h1 { margin: 0 0 8px; font-size: 24px; }
      p { color: #b7c0cf; line-height: 1.5; }
      label { display: block; margin-top: 18px; font-weight: 700; }
      input { box-sizing: border-box; width: 100%; margin-top: 8px; padding: 12px; border: 1px solid #3a4353; border-radius: 9px; background: #0f131b; color: #fff; }
      button { width: 100%; margin-top: 22px; padding: 13px; border: 0; border-radius: 9px; background: #ef4d3d; color: #fff; font-weight: 700; cursor: pointer; }
      button:disabled { opacity: .6; cursor: wait; }
      #result { min-height: 24px; margin-top: 16px; }
      .ok { color: #65d995; }
      .error { color: #ff8585; }
    </style>
  </head>
  <body>
    <main>
      <h1>Reactivate Luna / Sky</h1>
      <p>Enter the Zernio contact ID or the customer's WhatsApp number.</p>
      <form id="form">
        <label for="identifier">Contact ID or WhatsApp number</label>
        <input id="identifier" name="identifier" autocomplete="off" required />
        <label for="secret">Internal webhook secret</label>
        <input id="secret" name="secret" type="password" autocomplete="current-password" required />
        <button id="submit" type="submit">Reactivate assistant</button>
      </form>
      <div id="result" role="status" aria-live="polite"></div>
    </main>
    <script>
      const form = document.getElementById('form');
      const result = document.getElementById('result');
      const submit = document.getElementById('submit');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        result.textContent = '';
        result.className = '';
        submit.disabled = true;
        try {
          const response = await fetch('/api/reactivate-ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              identifier: document.getElementById('identifier').value,
              webhookSecret: document.getElementById('secret').value,
            }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Request failed');
          result.textContent = 'Luna / Sky is active for this contact.';
          result.className = 'ok';
          form.reset();
        } catch (error) {
          result.textContent = error.message || 'Could not reactivate the assistant.';
          result.className = 'error';
        } finally {
          submit.disabled = false;
        }
      });
    </script>
  </body>
</html>`;

export default function handler(_request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  response.status(200).send(page);
}
