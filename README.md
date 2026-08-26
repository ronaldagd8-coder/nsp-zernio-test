# NSP Zernio Test

Private test backend for the NEXT SOLUTIONS PARTNERS Zernio workflow.

Initial endpoints:

- `GET /` - service status
- `GET /health` - health check
- `POST /api/check-ai-status` - authenticated Zernio contact status lookup

The reactivation endpoints will be added after the status-check integration is verified.

Do not commit API keys or webhook secrets to this repository.
